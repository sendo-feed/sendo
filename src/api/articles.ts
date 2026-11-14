import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { type ArticleCursor, listArticles } from "../db/articles";
import type { Platform } from "../platform";
import { defaultHook } from "./hook";
import { ArticleSchema, ErrorSchema, errorBody, toArticleResponse } from "./schemas";

const ListQuerySchema = z.object({
  feedId: z.string().min(1).optional().openapi({ description: "このフィードの記事だけにする" }),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z
    .string()
    .max(512)
    .optional()
    .openapi({ description: "前のページの nextCursor。最初のページでは付けない" }),
});

const listRoute = createRoute({
  method: "get",
  path: "/articles",
  summary: "記事の一覧（新しい順）",
  request: { query: ListQuerySchema },
  responses: {
    200: {
      description: "記事。続きがあれば nextCursor を付けてもう一度呼ぶ",
      content: {
        "application/json": {
          schema: z.object({ items: z.array(ArticleSchema), nextCursor: z.string().nullable() }),
        },
      },
    },
    400: {
      description: "クエリが正しくない",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

export function articlesApi(platform: Platform) {
  return new OpenAPIHono({ defaultHook }).openapi(listRoute, async (c) => {
    const query = c.req.valid("query");
    const cursor = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
    if (cursor === null) return c.json(errorBody("invalid_request", "cursor: invalid"), 400);

    const { items, next } = await listArticles(platform.db, {
      feedId: query.feedId,
      limit: query.limit,
      cursor,
    });
    return c.json(
      {
        items: items.map(toArticleResponse),
        nextCursor: next === null ? null : encodeCursor(next),
      },
      200,
    );
  });
}

// 公開日時は 1970 年より前（負の値）もありうるので、符号は問わない
const CursorSchema = z.object({ p: z.int(), i: z.string().min(1) });

/** ページ送りの位置を、URL にそのまま載せられる文字列にする（中身に意味を持たせない） */
function encodeCursor(cursor: ArticleCursor): string {
  const json = JSON.stringify({ p: cursor.publishedAt, i: cursor.id });
  return btoa(json).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeCursor(value: string): ArticleCursor | null {
  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
    const parsed = CursorSchema.safeParse(JSON.parse(atob(base64)));
    return parsed.success ? { publishedAt: parsed.data.p, id: parsed.data.i } : null;
  } catch {
    return null;
  }
}
