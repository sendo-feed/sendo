import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import {
  addDiscordSubscription,
  connectDiscord,
  disconnectDiscord,
  getDiscordConnection,
  listDiscordSubscriptions,
} from "../db/discord";
import { getFolder } from "../db/folders";
import {
  DISCORD_INTEGRATION_PATH,
  discordAuthorizeUrl,
  discordChannelUrl,
  discordCursorBefore,
  discordInviteUrl,
  getReadableChannel,
  identifyDiscordUser,
  parseDiscordChannelUrl,
} from "../discord/client";
import { FetchFeedError } from "../fetcher/fetch-feed";
import { randomBase64Url } from "../lib/crypto";
import type { Platform } from "../platform";
import type { AuthVariables } from "./auth";
import { defaultHook } from "./hook";
import { safeReturnTo } from "./login";
import { ErrorSchema, errorBody } from "./schemas";

const PATH = DISCORD_INTEGRATION_PATH;
const OAUTH_COOKIE = "sendo_discord";
const STATE_TTL_SECONDS = 600;
const COOKIE_OPTIONS = {
  prefix: "host",
  path: "/",
  secure: true,
  httpOnly: true,
  sameSite: "Lax",
} as const;
const State = z.object({
  value: z.string(),
  sessionId: z.string(),
  returnTo: z.string(),
  expiresAt: z.number(),
});

const error = (description: string) => ({
  description,
  content: { "application/json": { schema: ErrorSchema } },
});

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  content: { "application/json": { schema } },
});

const security = [{ sessionCookie: [] as string[] }];
const sessionRequired = error("ブラウザのセッションが必要");
const disabled = error("Discord 連携の設定がない");
const ChannelSubscription = z.object({
  feedId: z.string(),
  url: z.string(),
  name: z.string().nullable(),
});
const ConnectResult = z.object({ authorizationUrl: z.url() });

const statusRoute = createRoute({
  method: "get",
  path: PATH,
  summary: "Discord の接続状態と購読中のチャンネルを返す",
  security,
  responses: {
    200: json(
      z
        .object({
          available: z.boolean(),
          connected: z.boolean(),
          inviteUrl: z.url().nullable(),
          subscriptions: z.array(ChannelSubscription),
        })
        .openapi("DiscordIntegration"),
      "接続状態",
    ),
    403: sessionRequired,
  },
});

const connectRoute = createRoute({
  method: "post",
  path: `${PATH}/connect`,
  summary: "Discord アカウントの接続を始める",
  description: "応答の authorizationUrl に同じブラウザを移す。許可したあとは returnTo に戻る。",
  security,
  request: {
    body: {
      required: true,
      content: {
        "application/json": { schema: z.object({ returnTo: z.string().max(1024).optional() }) },
      },
    },
  },
  responses: {
    200: json(ConnectResult, "Discord の許可画面の URL"),
    403: sessionRequired,
    501: disabled,
  },
});

const callbackRoute = createRoute({
  method: "get",
  path: `${PATH}/callback`,
  summary: "Discord の許可画面から戻る先",
  description:
    "接続開始時の returnTo に戻る。discord=connected、access_denied、invalid_state、already_connected、provider_error のいずれかを返す。",
  security,
  request: {
    query: z.object({
      code: z.string().max(2048).optional(),
      state: z.string().max(128).optional(),
      error: z.string().max(128).optional(),
    }),
  },
  responses: {
    302: { description: "接続の結果を付けて画面へ戻る" },
    403: sessionRequired,
    501: disabled,
  },
});

const subscribeRoute = createRoute({
  method: "post",
  path: `${PATH}/subscriptions`,
  summary: "Discord のチャンネルを購読する",
  description: "Discord のチャンネル URL を指定する。購読したあとの投稿を受信箱に取り込む。",
  security,
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z
            .object({
              url: z.string().max(256).openapi({ example: "https://discord.com/channels/111/222" }),
              folderId: z.string().min(1).max(64).nullable().optional(),
            })
            .openapi("DiscordSubscribeRequest"),
        },
      },
    },
  },
  responses: {
    200: json(ChannelSubscription, "購読済み"),
    201: json(ChannelSubscription, "購読した"),
    400: error("URL またはフォルダが正しくない"),
    403: sessionRequired,
    404: error("チャンネルがないか、本人または Bot に閲覧権限がない"),
    409: error("Discord アカウントとの接続がない"),
    501: disabled,
    502: error("Discord API が応答しないか、応答が正しくない"),
  },
});

const disconnectRoute = createRoute({
  method: "delete",
  path: PATH,
  summary: "Discord の接続を解除する",
  description: "この接続の購読と取り込んだ投稿を、スター付きも含めて削除する。",
  security,
  responses: {
    204: { description: "接続を解除した" },
    403: sessionRequired,
  },
});

export function discordApi(platform: Platform) {
  const { db } = platform;
  const api = new OpenAPIHono<{ Variables: AuthVariables }>({ defaultHook });
  api.use(`${PATH}/*`, async (c, next) => {
    if (c.get("auth").kind !== "session")
      return c.json(errorBody("forbidden", "session required"), 403);
    c.header("Cache-Control", "no-store");
    return next();
  });

  return api
    .openapi(statusRoute, async (c) => {
      const userId = c.get("user").id;
      const config = platform.discord;
      const [connection, subscriptions] = await Promise.all([
        getDiscordConnection(db, userId),
        listDiscordSubscriptions(db, userId),
      ]);
      return c.json(
        {
          available: config !== undefined,
          connected: connection !== undefined,
          inviteUrl: config ? discordInviteUrl(config) : null,
          subscriptions,
        },
        200,
      );
    })
    .openapi(connectRoute, async (c) => {
      const config = platform.discord;
      if (!config)
        return c.json(errorBody("feature_unavailable", "Discord is not configured"), 501);
      const auth = c.get("auth");
      if (auth.kind !== "session") return c.json(errorBody("forbidden", "session required"), 403);

      const state: z.infer<typeof State> = {
        value: randomBase64Url(32),
        sessionId: auth.sessionId,
        returnTo: safeReturnTo(c.req.valid("json").returnTo),
        expiresAt: platform.now().getTime() + STATE_TTL_SECONDS * 1000,
      };
      await setSignedCookie(c, OAUTH_COOKIE, JSON.stringify(state), config.clientSecret, {
        ...COOKIE_OPTIONS,
        maxAge: STATE_TTL_SECONDS,
      });
      return c.json({ authorizationUrl: discordAuthorizeUrl(config, state.value) }, 200);
    })
    .openapi(callbackRoute, async (c) => {
      const config = platform.discord;
      if (!config)
        return c.json(errorBody("feature_unavailable", "Discord is not configured"), 501);
      const auth = c.get("auth");
      if (auth.kind !== "session") return c.json(errorBody("forbidden", "session required"), 403);

      c.header("Referrer-Policy", "no-referrer");
      const cookie = await getSignedCookie(c, config.clientSecret, OAUTH_COOKIE, "host");
      deleteCookie(c, OAUTH_COOKIE, COOKIE_OPTIONS);
      const state =
        typeof cookie === "string" ? State.safeParse(JSON.parse(cookie)).data : undefined;
      const query = c.req.valid("query");
      const valid =
        state &&
        state.sessionId === auth.sessionId &&
        state.expiresAt > platform.now().getTime() &&
        state.value === query.state;
      const target = new URL(valid ? safeReturnTo(state.returnTo) : "/", config.redirectUri);
      const redirect = (result: string) => {
        target.searchParams.set("discord", result);
        return c.redirect(target.pathname + target.search + target.hash, 302);
      };
      if (!valid) return redirect("invalid_state");
      if (query.error === "access_denied") return redirect("access_denied");
      if (!query.code || query.error) return redirect("provider_error");

      try {
        const discordUserId = await identifyDiscordUser(platform.fetch, config, query.code);
        return redirect(
          (await connectDiscord(db, c.get("user").id, discordUserId))
            ? "connected"
            : "already_connected",
        );
      } catch (e) {
        if (e instanceof FetchFeedError) return redirect("provider_error");
        throw e;
      }
    })
    .openapi(subscribeRoute, async (c) => {
      const config = platform.discord;
      if (!config)
        return c.json(errorBody("feature_unavailable", "Discord is not configured"), 501);
      const userId = c.get("user").id;
      const { url, folderId = null } = c.req.valid("json");
      const address = parseDiscordChannelUrl(url.trim());
      if (!address)
        return c.json(errorBody("invalid_channel_url", "a Discord channel URL is required"), 400);
      if (folderId !== null && !(await getFolder(db, { userId, id: folderId }))) {
        return c.json(errorBody("folder_not_found", "folder does not exist"), 400);
      }
      const connection = await getDiscordConnection(db, userId);
      if (!connection)
        return c.json(errorBody("discord_not_connected", "connect a Discord account first"), 409);

      let channel: Awaited<ReturnType<typeof getReadableChannel>>;
      try {
        channel = await getReadableChannel(
          platform.fetch,
          config,
          address,
          connection.discordUserId,
        );
      } catch (e) {
        if (e instanceof FetchFeedError)
          return c.json(errorBody("discord_unavailable", e.message), 502);
        throw e;
      }
      if (!channel) {
        return c.json(
          errorBody("channel_not_found", "channel is not readable by both the user and the bot"),
          404,
        );
      }
      const now = platform.now();
      const added = await addDiscordSubscription(db, {
        userId,
        connectionId: connection.id,
        url: discordChannelUrl(address),
        name: channel.name,
        folderId,
        now,
        cursor: discordCursorBefore(now),
      });
      if (!added)
        return c.json(errorBody("discord_not_connected", "Discord connection changed"), 409);
      if (added.created)
        await platform.jobs.enqueue([{ type: "fetch-feed", feedId: added.feed.id }]);
      return c.json(
        {
          feedId: added.feed.id,
          url: added.feed.url,
          name: added.feed.title,
        },
        added.created ? 201 : 200,
      );
    })
    .openapi(disconnectRoute, async (c) => {
      await disconnectDiscord(db, c.get("user").id);
      deleteCookie(c, OAUTH_COOKIE, COOKIE_OPTIONS);
      return c.body(null, 204);
    });
}
