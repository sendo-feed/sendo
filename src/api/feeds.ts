import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { findFeedByUrl, insertFeed } from "../db/feeds";
import { getFolder } from "../db/folders";
import { backfillInbox } from "../db/inbox";
import type { Feed } from "../db/schema";
import {
  getSubscription,
  listSubscriptions,
  setSubscriptionFolder,
  subscribeMany,
  unsubscribe,
} from "../db/subscriptions";
import { DiscoverError, discoverFeed, findFeedLinks } from "../fetcher/discover";
import { FetchFeedError, fetchFeed } from "../fetcher/fetch-feed";
import { ParseFeedError, parseFeed } from "../fetcher/parse-feed";
import { toFetchableUrl, UrlNotAllowedError } from "../fetcher/url-guard";
import type { Platform } from "../platform";
import type { AuthVariables } from "./auth";
import { defaultHook } from "./hook";
import { ErrorSchema, errorBody, FeedSchema, toFeedResponse } from "./schemas";

const IdParamSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(64)
    .openapi({ param: { name: "id", in: "path" } }),
});

const error = (description: string) => ({
  description,
  content: { "application/json": { schema: ErrorSchema } },
});

const SubscribeBodySchema = z
  .object({
    url: z.string().max(2048).openapi({
      example: "https://example.com/",
      description: "フィードの URL か、フィードを持つサイトの URL",
    }),
    folderId: z.string().min(1).max(64).nullable().optional(),
  })
  .openapi("SubscribeRequest");

const subscribeRoute = createRoute({
  method: "post",
  path: "/feeds",
  summary: "フィードを購読する",
  description: [
    "フィードの URL か、サイトの URL を受け取る。サイトの URL なら、ページの",
    '<link rel="alternate"> からフィードを見つける。見つけたフィードを実際に取得して、',
    "読めることを確かめてから登録し、記事の取得をキューに積む。",
    "同じフィードをすでに購読していれば、それを返す（200）。",
  ].join("\n"),
  request: {
    body: { required: true, content: { "application/json": { schema: SubscribeBodySchema } } },
  },
  responses: {
    200: {
      description: "すでに購読している",
      content: { "application/json": { schema: z.object({ feed: FeedSchema }) } },
    },
    201: {
      description: "購読した",
      content: { "application/json": { schema: z.object({ feed: FeedSchema }) } },
    },
    400: error("URL が正しくない、取得が許されていない、またはフォルダがない"),
    422: error(
      "取得できなかった（fetch_failed）、またはフィードが見つからなかった（feed_not_found）",
    ),
  },
});

const discoverRoute = createRoute({
  method: "get",
  path: "/feeds/discover",
  summary: "URL にあるフィードの候補を調べる",
  description:
    "購読はしない。サイトに複数のフィード（記事、コメントなど）があるときに選ぶのに使う。",
  request: { query: z.object({ url: z.string().max(2048) }) },
  responses: {
    200: {
      description: "フィードの候補。URL そのものがフィードなら、それだけを返す",
      content: {
        "application/json": {
          schema: z.object({
            candidates: z.array(z.object({ url: z.string(), title: z.string().nullable() })),
          }),
        },
      },
    },
    400: error("URL が正しくない、または取得が許されていない"),
    422: error("取得できなかった"),
  },
});

const listRoute = createRoute({
  method: "get",
  path: "/feeds",
  summary: "購読しているフィードの一覧",
  responses: {
    200: {
      description: "購読しているフィード（登録した順）",
      content: { "application/json": { schema: z.object({ items: z.array(FeedSchema) }) } },
    },
  },
});

const updateRoute = createRoute({
  method: "patch",
  path: "/feeds/{id}",
  summary: "購読を変える（フォルダの移動）",
  request: {
    params: IdParamSchema,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z
            .object({
              folderId: z
                .string()
                .min(1)
                .max(64)
                .nullable()
                .openapi({ description: "null ならフォルダなしにする" }),
            })
            .openapi("UpdateFeedRequest"),
        },
      },
    },
  },
  responses: {
    200: {
      description: "変えた",
      content: { "application/json": { schema: z.object({ feed: FeedSchema }) } },
    },
    400: error("フォルダがない"),
    404: error("フィードがない"),
  },
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/feeds/{id}",
  summary: "購読をやめる",
  description:
    "フィードの記事は、スターを付けたものを除いて受信箱から消える。フィードと記事そのものは、ほかの人のために残る。",
  request: { params: IdParamSchema },
  responses: {
    204: { description: "消した" },
    404: error("フィードがない"),
  },
});

export function feedsApi(platform: Platform) {
  const { db } = platform;

  const parseUrl = (raw: string): URL | UrlNotAllowedError => {
    try {
      return toFetchableUrl(raw);
    } catch (e) {
      if (e instanceof UrlNotAllowedError) return e;
      throw e;
    }
  };

  /**
   * フィード（共有）をユーザーが購読する。新しく購読したら、すでに取り込んである最近の記事を
   * 受信箱に入れ、しばらく取得していないフィードなら取得を積む。
   */
  const subscribe = async (input: {
    userId: string;
    feed: Feed;
    feedCreated: boolean;
    folderId: string | null;
  }) => {
    const now = platform.now();
    const created =
      (
        await subscribeMany(db, {
          userId: input.userId,
          rows: [{ feedId: input.feed.id, folderId: input.folderId }],
          now,
        })
      ).length > 0;
    if (created && !input.feedCreated) {
      await backfillInbox(db, { userId: input.userId, feedIds: [input.feed.id], now });
    }
    if (input.feedCreated || (created && input.feed.nextFetchAt <= now)) {
      await platform.jobs.enqueue([{ type: "fetch-feed", feedId: input.feed.id }]);
    }
    const subscription = await getSubscription(db, {
      userId: input.userId,
      feedId: input.feed.id,
    });
    if (!subscription) throw new Error(`subscription disappeared: ${input.feed.id}`);
    return { subscription, created };
  };

  return new OpenAPIHono<{ Variables: AuthVariables }>({ defaultHook })
    .openapi(subscribeRoute, async (c) => {
      const user = c.get("user");
      const body = c.req.valid("json");
      const url = parseUrl(body.url);
      if (url instanceof UrlNotAllowedError) {
        return c.json(errorBody("url_not_allowed", url.message), 400);
      }
      const folderId = body.folderId ?? null;
      if (folderId !== null && !(await getFolder(db, { userId: user.id, id: folderId }))) {
        return c.json(errorBody("folder_not_found", "folder does not exist"), 400);
      }

      // フィード（共有）がすでにあれば、取得せずに購読する
      const existing = await findFeedByUrl(db, url.href);
      if (existing) {
        const { subscription, created } = await subscribe({
          userId: user.id,
          feed: existing,
          feedCreated: false,
          folderId,
        });
        return c.json({ feed: toFeedResponse(subscription) }, created ? 201 : 200);
      }

      let discovered: Awaited<ReturnType<typeof discoverFeed>>;
      try {
        discovered = await discoverFeed(url, { fetch: platform.fetch });
      } catch (e) {
        if (e instanceof DiscoverError) return c.json(errorBody(e.code, e.message), 422);
        throw e;
      }

      const { feed, created: feedCreated } = await insertFeed(db, {
        id: crypto.randomUUID(),
        url: discovered.url,
        // 確かめるときに読んだタイトルを先に入れておく。取得のジョブが終わるまで、名前のない
        // フィードが一覧に並ばないように
        title: discovered.title,
        now: platform.now(),
      });
      const { subscription, created } = await subscribe({
        userId: user.id,
        feed,
        feedCreated,
        folderId,
      });
      return c.json({ feed: toFeedResponse(subscription) }, created ? 201 : 200);
    })
    .openapi(discoverRoute, async (c) => {
      const url = parseUrl(c.req.valid("query").url);
      if (url instanceof UrlNotAllowedError) {
        return c.json(errorBody("url_not_allowed", url.message), 400);
      }

      let page: Awaited<ReturnType<typeof fetchFeed>>;
      try {
        page = await fetchFeed(url.href, { fetch: platform.fetch });
      } catch (e) {
        if (e instanceof FetchFeedError) return c.json(errorBody("fetch_failed", e.message), 422);
        throw e;
      }
      if (page.status !== "ok") return c.json({ candidates: [] }, 200);

      try {
        const feed = parseFeed(page.body, page.url);
        return c.json({ candidates: [{ url: url.href, title: feed.title }] }, 200);
      } catch (e) {
        if (!(e instanceof ParseFeedError)) throw e;
      }
      const candidates = findFeedLinks(page.body, page.url).filter(
        (candidate) => !(parseUrl(candidate.url) instanceof UrlNotAllowedError),
      );
      return c.json({ candidates }, 200);
    })
    .openapi(listRoute, async (c) => {
      const subscriptions = await listSubscriptions(db, c.get("user").id);
      return c.json({ items: subscriptions.map(toFeedResponse) }, 200);
    })
    .openapi(updateRoute, async (c) => {
      const user = c.get("user");
      const { id } = c.req.valid("param");
      const { folderId } = c.req.valid("json");
      if (folderId !== null && !(await getFolder(db, { userId: user.id, id: folderId }))) {
        return c.json(errorBody("folder_not_found", "folder does not exist"), 400);
      }
      const updated = await setSubscriptionFolder(db, { userId: user.id, feedId: id, folderId });
      const subscription = updated && (await getSubscription(db, { userId: user.id, feedId: id }));
      if (!subscription) return c.json(errorBody("not_found", "feed is not subscribed"), 404);
      return c.json({ feed: toFeedResponse(subscription) }, 200);
    })
    .openapi(deleteRoute, async (c) => {
      const { id } = c.req.valid("param");
      if (!(await unsubscribe(db, { userId: c.get("user").id, feedId: id, now: platform.now() }))) {
        return c.json(errorBody("not_found", "feed is not subscribed"), 404);
      }
      return c.body(null, 204);
    });
}
