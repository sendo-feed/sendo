import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { ACTIVITY_BATCH_LIMIT, recordArticleOpens } from "../db/activity";
import type { Platform } from "../platform";
import type { AuthVariables } from "./auth";
import { defaultHook } from "./hook";
import { ErrorSchema } from "./schemas";

const route = createRoute({
  method: "post",
  path: "/activity",
  summary: "reader で記事を開いた記録を受け取る",
  description:
    "イベント ID は、同じ開封を送り直すときも同じ値を使う。応答はこのリクエストで新しく記録した件数を返す。",
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({
            events: z
              .array(
                z.object({
                  id: z.uuid(),
                  articleId: z.string().min(1).max(64),
                  occurredAt: z.iso.datetime({ offset: true }),
                }),
              )
              .min(1)
              .max(ACTIVITY_BATCH_LIMIT),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "このリクエストで新しく記録した件数",
      content: { "application/json": { schema: z.object({ recorded: z.int().nonnegative() }) } },
    },
    400: {
      description: "入力が正しくない",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

export function activityApi(platform: Platform) {
  return new OpenAPIHono<{ Variables: AuthVariables }>({ defaultHook }).openapi(
    route,
    async (c) => {
      const { events } = c.req.valid("json");
      const recorded = await recordArticleOpens(platform.db, {
        userId: c.get("user").id,
        now: platform.now(),
        events: events.map(({ id, articleId, occurredAt }) => ({
          id: id.toLowerCase(),
          articleId,
          occurredAt: new Date(occurredAt),
        })),
      });
      return c.json({ recorded }, 200);
    },
  );
}
