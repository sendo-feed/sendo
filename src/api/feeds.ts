import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { insertFeed, listFeeds } from "../db/feeds";
import { toFetchableUrl, UrlNotAllowedError } from "../fetcher/url-guard";
import type { Platform } from "../platform";
import { defaultHook } from "./hook";
import { ErrorSchema, errorBody, FeedSchema, toFeedResponse } from "./schemas";

const SubscribeBodySchema = z
  .object({
    url: z.string().max(2048).openapi({ example: "https://example.com/feed.xml" }),
  })
  .openapi("SubscribeRequest");

const subscribeRoute = createRoute({
  method: "post",
  path: "/feeds",
  summary: "フィードを購読する",
  description:
    "フィードの URL を登録し、取得をキューに積む。同じ URL がすでにあれば、それを返す（200）。",
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
    400: {
      description: "URL が正しくない、または取得が許されていない",
      content: { "application/json": { schema: ErrorSchema } },
    },
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

export function feedsApi(platform: Platform) {
  return new OpenAPIHono({ defaultHook })
    .openapi(subscribeRoute, async (c) => {
      let url: URL;
      try {
        url = toFetchableUrl(c.req.valid("json").url);
      } catch (error) {
        if (error instanceof UrlNotAllowedError) {
          return c.json(errorBody("url_not_allowed", error.message), 400);
        }
        throw error;
      }

      const { feed, created } = await insertFeed(platform.db, {
        id: crypto.randomUUID(),
        url: url.href,
        now: platform.now(),
      });
      if (!created) return c.json({ feed: toFeedResponse(feed) }, 200);

      await platform.jobs.enqueue([{ type: "fetch-feed", feedId: feed.id }]);
      return c.json({ feed: toFeedResponse(feed) }, 201);
    })
    .openapi(listRoute, async (c) => {
      const feeds = await listFeeds(platform.db);
      return c.json({ items: feeds.map(toFeedResponse) }, 200);
    });
}
