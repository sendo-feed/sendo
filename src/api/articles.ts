import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  type ArticleCursor,
  countUnreadByFeed,
  listArticles,
  MAX_MARK_READ_IDS,
  type MarkReadScope,
  markArticlesRead,
  setArticleState,
} from "../db/articles";
import { dbNow } from "../db/clock";
import { listFeeds } from "../db/feeds";
import type { Platform } from "../platform";
import { defaultHook } from "./hook";
import { ArticleSchema, ErrorSchema, errorBody, toArticleResponse } from "./schemas";

const ListQuerySchema = z.object({
  feedId: z.string().min(1).optional().openapi({ description: "このフィードの記事だけにする" }),
  folderId: z
    .string()
    .min(1)
    .optional()
    .openapi({ description: "このフォルダのフィードの記事だけにする" }),
  state: z
    .enum(["all", "unread", "starred"])
    .default("all")
    .openapi({ description: "unread なら未読だけ、starred ならスター付きだけ" }),
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
          schema: z.object({
            items: z.array(ArticleSchema),
            nextCursor: z.string().nullable(),
            asOf: z.iso.datetime().openapi({
              description:
                "この一覧がいつ時点のものか（サーバーの DB の時計）。まとめて既読にするときは、最初のページの asOf を until に渡す。一覧に出ていなかった記事は未読のまま残る",
            }),
          }),
        },
      },
    },
    400: {
      description: "クエリが正しくない",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const error = (description: string) => ({
  description,
  content: { "application/json": { schema: ErrorSchema } },
});

const updateRoute = createRoute({
  method: "patch",
  path: "/articles/{id}",
  summary: "記事の既読とスターを変える",
  description: "指定しなかったほうは変えない。すでにその状態なら、時刻は変えない。",
  request: {
    params: z.object({
      id: z
        .string()
        .min(1)
        .max(64)
        .openapi({ param: { name: "id", in: "path" } }),
    }),
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z
            .object({ read: z.boolean().optional(), starred: z.boolean().optional() })
            .refine((body) => body.read !== undefined || body.starred !== undefined, {
              message: "read か starred のどちらかを指定する",
            })
            .openapi("UpdateArticleRequest"),
        },
      },
    },
  },
  responses: {
    200: {
      description: "変えた",
      content: { "application/json": { schema: z.object({ article: ArticleSchema }) } },
    },
    400: error("本文が正しくない"),
    404: error("記事がない"),
  },
});

const MarkReadBodySchema = z
  .object({
    ids: z.array(z.string().min(1).max(64)).min(1).max(MAX_MARK_READ_IDS).optional(),
    feedId: z.string().min(1).max(64).optional(),
    folderId: z.string().min(1).max(64).optional(),
    all: z.literal(true).optional(),
    until: z.iso.datetime().optional().openapi({
      description:
        "この時刻より前に取り込んだ記事だけを既読にする（ids 以外では必須）。記事の一覧の最初のページの asOf を渡す。クライアントの時計の時刻は使わない（サーバーとずれていると、一覧に出ていなかった記事まで既読になる）",
    }),
  })
  .superRefine((body, ctx) => {
    const scopes = [body.ids, body.feedId, body.folderId, body.all].filter((v) => v !== undefined);
    if (scopes.length !== 1) {
      ctx.addIssue({
        code: "custom",
        message: "ids ／ feedId ／ folderId ／ all のどれか 1 つを指定する",
      });
    }
    if (body.ids === undefined && body.until === undefined) {
      ctx.addIssue({ code: "custom", path: ["until"], message: "ids 以外では until が必須" });
    }
  })
  .openapi("MarkReadRequest");

const markReadRoute = createRoute({
  method: "post",
  path: "/articles/mark-read",
  summary: "まとめて既読にする",
  description: "ID を並べるか、フィード ／ フォルダ ／ すべてを指定する。",
  request: {
    body: { required: true, content: { "application/json": { schema: MarkReadBodySchema } } },
  },
  responses: {
    200: {
      description: "既読にした",
      content: {
        "application/json": {
          schema: z.object({
            updated: z.int().nonnegative().openapi({ description: "既読にした記事の数" }),
          }),
        },
      },
    },
    400: error("本文が正しくない"),
  },
});

const unreadCountsRoute = createRoute({
  method: "get",
  path: "/unread-counts",
  summary: "未読の数",
  description: "未読のないフィード ／ フォルダは含まない。",
  responses: {
    200: {
      description: "全体、フィードごと、フォルダごとの未読の数",
      content: {
        "application/json": {
          schema: z
            .object({
              total: z.int().nonnegative(),
              feeds: z.array(z.object({ feedId: z.string(), unread: z.int().positive() })),
              folders: z.array(z.object({ folderId: z.string(), unread: z.int().positive() })),
            })
            .openapi("UnreadCounts"),
        },
      },
    },
  },
});

export function articlesApi(platform: Platform) {
  const { db } = platform;
  return new OpenAPIHono({ defaultHook })
    .openapi(updateRoute, async (c) => {
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const article = await setArticleState(db, {
        id,
        read: body.read,
        starred: body.starred,
        now: platform.now(),
      });
      if (!article) return c.json(errorBody("not_found", "article does not exist"), 404);
      return c.json({ article: toArticleResponse(article) }, 200);
    })
    .openapi(markReadRoute, async (c) => {
      const body = c.req.valid("json");
      const until = body.until === undefined ? undefined : new Date(body.until);
      const scope: MarkReadScope | undefined =
        body.ids !== undefined
          ? { ids: body.ids }
          : until === undefined
            ? undefined
            : body.feedId !== undefined
              ? { feedId: body.feedId, until }
              : body.folderId !== undefined
                ? { folderId: body.folderId, until }
                : { all: true, until };
      // 本文の検証（superRefine）を通っていれば、ここには来ない
      if (scope === undefined) return c.json(errorBody("invalid_request", "until: required"), 400);
      const updated = await markArticlesRead(db, { scope, now: platform.now() });
      return c.json({ updated }, 200);
    })
    .openapi(unreadCountsRoute, async (c) => {
      const [byFeed, feeds] = [await countUnreadByFeed(db), await listFeeds(db)];
      const byFolder = new Map<string, number>();
      for (const feed of feeds) {
        const unread = byFeed.get(feed.id);
        if (unread === undefined || feed.folderId === null) continue;
        byFolder.set(feed.folderId, (byFolder.get(feed.folderId) ?? 0) + unread);
      }
      return c.json(
        {
          total: [...byFeed.values()].reduce((sum, n) => sum + n, 0),
          feeds: [...byFeed].map(([feedId, unread]) => ({ feedId, unread })),
          folders: [...byFolder].map(([folderId, unread]) => ({ folderId, unread })),
        },
        200,
      );
    })
    .openapi(listRoute, async (c) => {
      const query = c.req.valid("query");
      const cursor = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
      if (cursor === null) return c.json(errorBody("invalid_request", "cursor: invalid"), 400);

      // 一覧を読む前に取る。読んだあとに取ると、読んだあとに届いた記事が asOf より前になり、
      // まとめて既読で、一覧に出ていなかったのに既読になる
      const asOf = await dbNow(platform.db);
      const { items, next } = await listArticles(platform.db, {
        feedId: query.feedId,
        folderId: query.folderId,
        state: query.state,
        limit: query.limit,
        cursor,
      });
      return c.json(
        {
          items: items.map(toArticleResponse),
          nextCursor: next === null ? null : encodeCursor(next),
          asOf: asOf.toISOString(),
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
