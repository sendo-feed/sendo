import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { clearArticleTag, setArticleTag } from "../db/article-tags";
import { enqueueRejudgeAfterWrite } from "../jobs/tag-judging";
import type { Platform } from "../platform";
import type { AuthVariables } from "./auth";
import { defaultHook } from "./hook";
import { ArticleTagSchema, ErrorSchema, errorBody, toArticleTagResponse } from "./schemas";

/*
 * 記事のタグの手の付け外しと取り消し（docs/decisions/tags.md の 5、6）。
 */

const ParamsSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(64)
    .openapi({ param: { name: "id", in: "path" }, description: "記事の ID" }),
  tagId: z
    .string()
    .min(1)
    .max(64)
    .openapi({ param: { name: "tagId", in: "path" } }),
});

const notFound = {
  description:
    "本人の有効なタグがないか、記事が本人の受信箱にない（ほかの人の受信箱にある記事かどうかは漏らさない）",
  content: { "application/json": { schema: ErrorSchema } },
};

const setRoute = createRoute({
  method: "put",
  path: "/articles/{id}/tags/{tagId}",
  summary: "記事のタグを手で付け外しする",
  description: "同じ状態の再送も同じ応答。自動のタグ付けは、手で付け外しした記事のタグを変えない",
  request: {
    params: ParamsSchema,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z
            .strictObject({
              on: z.boolean().openapi({ description: "true なら付け、false なら外す" }),
            })
            .openapi("SetArticleTagRequest"),
        },
      },
    },
  },
  responses: {
    200: {
      description: "付け外しした",
      content: { "application/json": { schema: z.object({ articleTag: ArticleTagSchema }) } },
    },
    404: notFound,
  },
});

const clearRoute = createRoute({
  method: "delete",
  path: "/articles/{id}/tags/{tagId}",
  summary: "記事のタグの手直しを取り消し、自動に戻す",
  description:
    "手で付け外しした記事のタグだけを取り消す。自動のタグ付けが判定し直すまでは、付いていないものとして見える。手直しがなければ何も変えずに 204",
  request: { params: ParamsSchema },
  responses: {
    204: { description: "取り消した、または取り消す手直しがなかった" },
    404: notFound,
  },
});

export function articleTagsApi(platform: Platform) {
  const { db } = platform;
  return new OpenAPIHono<{ Variables: AuthVariables }>({ defaultHook })
    .openapi(setRoute, async (c) => {
      const { id, tagId } = c.req.valid("param");
      const result = await setArticleTag(db, {
        userId: c.get("user").id,
        articleId: id,
        tagId,
        on: c.req.valid("json").on,
      });
      if (result === "not_found") {
        return c.json(errorBody("not_found", "article or tag does not exist"), 404);
      }
      // 手直しの見える状態が変わっていれば、トリガーがタグの版を上げている（docs/decisions/auto-tagging.md の 4）
      await enqueueRejudgeAfterWrite(platform, c.get("user").id);
      return c.json({ articleTag: toArticleTagResponse(result) }, 200);
    })
    .openapi(clearRoute, async (c) => {
      const { id, tagId } = c.req.valid("param");
      const result = await clearArticleTag(db, { userId: c.get("user").id, articleId: id, tagId });
      if (result === "not_found") {
        return c.json(errorBody("not_found", "article or tag does not exist"), 404);
      }
      await enqueueRejudgeAfterWrite(platform, c.get("user").id);
      return c.body(null, 204);
    });
}
