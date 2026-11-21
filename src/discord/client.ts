import { z } from "zod";
import { FetchFeedError, parseRetryAfter } from "../fetcher/fetch-feed";
import { toFetchableUrl } from "../fetcher/url-guard";
import { readLimited } from "../lib/read-limited";
import type { DiscordConfig } from "../platform";

const DISCORD_API = "https://discord.com/api/v10";
const DISCORD_EPOCH_MS = Date.UTC(2015, 0, 1);
export const DISCORD_INTEGRATION_PATH = "/integrations/discord";
export const DISCORD_CALLBACK_PATH = `/api/v1${DISCORD_INTEGRATION_PATH}/callback`;
export const Snowflake = z.string().regex(/^[1-9][0-9]{0,19}$/);
const Bitfield = z
  .string()
  .regex(/^[0-9]{1,30}$/)
  .transform(BigInt);

const VIEW_CHANNEL = 1n << 10n;
const READ_MESSAGE_HISTORY = 1n << 16n;
const READ = VIEW_CHANNEL | READ_MESSAGE_HISTORY;
const ADMINISTRATOR = 1n << 3n;

const Guild = z.object({
  owner_id: Snowflake,
  // 形の違う値でも取得は止めず、アイコンだけを決めない（discordGuildIconUrl）
  icon: z.unknown().optional(),
  roles: z.array(z.object({ id: Snowflake, permissions: Bitfield })),
});
const Member = z.object({
  roles: z.array(Snowflake),
  pending: z.boolean().optional(),
});
const Channel = z.object({
  id: Snowflake,
  guild_id: Snowflake,
  name: z.string(),
  type: z.number(),
  nsfw: z.boolean().optional(),
  permission_overwrites: z
    .array(
      z.object({
        id: Snowflake,
        type: z.union([z.literal(0), z.literal(1)]),
        allow: Bitfield,
        deny: Bitfield,
      }),
    )
    .optional(),
});
const Message = z.object({
  id: Snowflake,
  channel_id: Snowflake,
  timestamp: z.iso.datetime({ offset: true }),
  type: z.number(),
  content: z.string().max(4000),
  author: z.object({ username: z.string(), global_name: z.string().nullable().optional() }),
  attachments: z.array(z.unknown()),
  embeds: z.array(z.unknown()),
});

export const DISCORD_PAGE_SIZE = 30;
/** 購読したときに取り込む、直近の投稿の数（docs/decisions/discord.md の 3） */
export const DISCORD_INITIAL_MESSAGES = 20;
/** まだ 1 回も取得していないフィードの取得位置。どのメッセージ ID よりも小さい */
export const DISCORD_CURSOR_START = "0";

/** 同じミリ秒に投稿されたメッセージも取得できるように、時刻の直前の ID を返す */
export function discordCursorBefore(date: Date): string {
  const sinceEpoch = date.getTime() - DISCORD_EPOCH_MS;
  return sinceEpoch <= 0 ? "0" : ((BigInt(sinceEpoch) << 22n) - 1n).toString();
}

export type ChannelAddress = { guildId: string; channelId: string };
export const discordChannelUrl = ({ guildId, channelId }: ChannelAddress) =>
  `https://discord.com/channels/${guildId}/${channelId}`;

export function parseDiscordChannelUrl(url: string): ChannelAddress | null {
  const match =
    /^https:\/\/discord\.com\/channels\/([1-9][0-9]{0,19})\/([1-9][0-9]{0,19})\/?$/.exec(url);
  return match?.[1] && match[2] ? { guildId: match[1], channelId: match[2] } : null;
}

export const discordInviteUrl = (config: DiscordConfig) =>
  authorizeUrl({
    client_id: config.clientId,
    scope: "bot",
    integration_type: "0",
    permissions: READ.toString(),
  });

export const discordAuthorizeUrl = (config: DiscordConfig, state: string) =>
  authorizeUrl({
    client_id: config.clientId,
    scope: "identify",
    response_type: "code",
    redirect_uri: config.redirectUri,
    state,
  });

function authorizeUrl(params: Record<string, string>): string {
  const url = new URL("https://discord.com/oauth2/authorize");
  url.search = new URLSearchParams(params).toString();
  return url.href;
}

export async function identifyDiscordUser(
  fetch: typeof globalThis.fetch,
  config: DiscordConfig,
  code: string,
): Promise<string> {
  const { access_token } = await request(
    fetch,
    "/oauth2/token",
    z.object({
      access_token: z.string().min(1),
    }),
    {
      method: "POST",
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: "authorization_code",
        code,
        redirect_uri: config.redirectUri,
      }),
    },
  );
  const user = await request(fetch, "/users/@me", z.object({ id: Snowflake }), {
    headers: { authorization: `Bearer ${access_token}` },
  });
  return user.id;
}

/** 本人と Bot の両方が読める、通常のテキストチャンネルかアナウンスチャンネルだけを扱う */
export async function getReadableChannel(
  fetch: typeof globalThis.fetch,
  config: DiscordConfig,
  address: ChannelAddress,
  userId: string,
): Promise<{ name: string; iconUrl: string | null | undefined } | null> {
  const { guildId, channelId } = address;
  const bot = { headers: { authorization: `Bot ${config.botToken}` } };
  const [channel, guild, user, botMember] = await Promise.all([
    request(fetch, `/channels/${channelId}`, Channel, bot),
    request(fetch, `/guilds/${guildId}`, Guild, bot),
    request(fetch, `/guilds/${guildId}/members/${userId}`, Member, bot),
    request(fetch, `/guilds/${guildId}/members/${config.clientId}`, Member, bot),
  ]).catch((error: unknown) => {
    if (isDiscordAccessDenied(error)) return [null, null, null, null] as const;
    throw error;
  });
  if (
    !channel ||
    !guild ||
    !user ||
    !botMember ||
    channel.guild_id !== guildId ||
    channel.id !== channelId ||
    (channel.type !== 0 && channel.type !== 5) ||
    channel.nsfw ||
    !canRead(guild, channel, user, guildId, userId) ||
    !canRead(guild, channel, botMember, guildId, config.clientId)
  )
    return null;
  return { name: channel.name, iconUrl: discordGuildIconUrl(guildId, guild.icon) };
}

/**
 * サーバーのアイコンの URL（docs/decisions/discord.md の 7）。アイコンがなければ null。
 * 値の形が違えば undefined（今のアイコンを変えない）。動くアイコン（a_）も png で静止画を取る
 */
export function discordGuildIconUrl(guildId: string, icon: unknown): string | null | undefined {
  if (icon === null || icon === undefined) return null;
  if (typeof icon !== "string" || !/^(a_)?[0-9a-f]{32}$/.test(icon)) return undefined;
  return `https://cdn.discordapp.com/icons/${guildId}/${icon}.png`;
}

function canRead(
  guild: z.infer<typeof Guild>,
  channel: z.infer<typeof Channel>,
  member: z.infer<typeof Member>,
  guildId: string,
  memberId: string,
): boolean {
  if (member.pending) return false;
  if (memberId === guild.owner_id) return true;

  const roleIds = new Set(member.roles);
  let permissions = 0n;
  for (const role of guild.roles) {
    if (role.id === guildId || roleIds.has(role.id)) permissions |= role.permissions;
  }
  if (permissions & ADMINISTRATOR) return true;
  const overwrites = channel.permission_overwrites;
  if (overwrites === undefined || !guild.roles.some((role) => role.id === guildId)) {
    throw new FetchFeedError("network", "Discord did not return channel permissions");
  }
  const everyone = overwrites.find((entry) => entry.type === 0 && entry.id === guildId);
  if (everyone) permissions = (permissions & ~everyone.deny) | everyone.allow;
  let denied = 0n;
  let allowed = 0n;
  for (const entry of overwrites) {
    if (entry.type === 0 && roleIds.has(entry.id) && entry.id !== guildId) {
      denied |= entry.deny;
      allowed |= entry.allow;
    }
  }
  permissions = (permissions & ~denied) | allowed;
  const individual = overwrites.find((entry) => entry.type === 1 && entry.id === memberId);
  if (individual) permissions = (permissions & ~individual.deny) | individual.allow;

  // Discord のタイムアウトでも、閲覧と履歴読み取りの権限は残る。
  return (permissions & READ) === READ;
}

class DiscordHttpError extends FetchFeedError {
  constructor(
    status: number,
    retryAfterMs: number | undefined,
    readonly discordCode?: number,
  ) {
    super(
      status === 429 ? "rate_limited" : "http_status",
      `Discord returned HTTP ${status}`,
      status,
      retryAfterMs,
    );
  }
}

export function isDiscordAccessDenied(error: unknown): boolean {
  if (!(error instanceof DiscordHttpError)) return false;
  // Discord のエラーコードで、プロキシや一時的な遮断と区別する。
  return (
    (error.status === 403 && (error.discordCode === 50001 || error.discordCode === 50013)) ||
    (error.status === 404 &&
      (error.discordCode === 10003 ||
        error.discordCode === 10004 ||
        error.discordCode === 10007 ||
        error.discordCode === 10013))
  );
}

/**
 * 取得位置より後の投稿を、古いほうから 1 ページ分返す。まだ 1 回も取得していなければ
 * （DISCORD_CURSOR_START）、直近の投稿を返す
 */
export async function getDiscordMessages(
  fetch: typeof globalThis.fetch,
  config: DiscordConfig,
  channelId: string,
  after: string,
) {
  const range =
    after === DISCORD_CURSOR_START
      ? `limit=${DISCORD_INITIAL_MESSAGES}`
      : `after=${after}&limit=${DISCORD_PAGE_SIZE}`;
  const messages = await request(
    fetch,
    `/channels/${channelId}/messages?${range}`,
    z.array(Message).max(DISCORD_PAGE_SIZE),
    { headers: { authorization: `Bot ${config.botToken}` } },
  );
  if (
    messages.some(
      (message) => message.channel_id !== channelId || BigInt(message.id) <= BigInt(after),
    )
  ) {
    throw new FetchFeedError("network", "Discord returned messages outside the requested range");
  }
  return messages;
}

async function request<T>(
  fetch: typeof globalThis.fetch,
  path: string,
  schema: z.ZodType<T>,
  init: RequestInit,
): Promise<T> {
  try {
    const url = toFetchableUrl(DISCORD_API + path);
    const headers = new Headers(init.headers);
    headers.set("user-agent", "DiscordBot (https://github.com/sendo-feed/sendo, 0.0)");
    const res = await fetch(url, {
      ...init,
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const retryHeader = res.headers.get("retry-after")?.trim() ?? null;
      // Discord のレート制限は、秒数に小数が入る場合がある。
      const retryAfter =
        res.status === 429 && retryHeader && /^\d{1,15}\.\d+$/.test(retryHeader)
          ? Math.ceil(Number(retryHeader) * 1000)
          : parseRetryAfter(retryHeader, { date: res.headers.get("date"), now: new Date() });
      const discordCode =
        res.status === 403 || res.status === 404 ? await readDiscordErrorCode(res) : undefined;
      if (!res.bodyUsed) await res.body?.cancel();
      throw new DiscordHttpError(res.status, retryAfter, discordCode);
    }
    const bytes = await readLimited(res.body, res.headers.get("content-length"), 2 * 1024 * 1024);
    return schema.parse(JSON.parse(new TextDecoder().decode(bytes)));
  } catch (error) {
    if (error instanceof FetchFeedError) throw error;
    // レスポンス本文、トークン、認可コードをエラーやログに出さない。
    throw new FetchFeedError("network", "Discord API request failed");
  }
}

async function readDiscordErrorCode(res: Response): Promise<number | undefined> {
  try {
    const bytes = await readLimited(res.body, res.headers.get("content-length"), 4096);
    const payload = z.object({ code: z.number() });
    return payload.safeParse(JSON.parse(new TextDecoder().decode(bytes))).data?.code;
  } catch {
    return undefined;
  }
}
