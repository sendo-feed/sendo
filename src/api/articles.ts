import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { dbNow } from "../db/clock";
import {
  type ArticleCursor,
  countUnreadByFeed,
  getInboxArticle,
  listInbox,
  MAX_MARK_READ_IDS,
  type MarkReadBoundary,
  type MarkReadScope,
  markArticlesRead,
  setArticleState,
} from "../db/inbox";
import { imageSigner } from "../db/secrets";
import { listSubscriptions } from "../db/subscriptions";
import { loadPageContent } from "../fetcher/page-content";
import { sanitizeHtmlWithImages } from "../lib/sanitize-html";
import type { Platform } from "../platform";
import type { AuthVariables } from "./auth";
import { defaultHook } from "./hook";
import { ArticleSchema, ErrorSchema, errorBody, toArticleResponse } from "./schemas";
import { decodeSyncCursor } from "./sync";

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

const contentRoute = createRoute({
  method: "get",
  path: "/articles/{id}/content",
  summary: "記事の本文",
  description: [
    "記事の本文（HTML）を返す。出どころは 2 つあり、source で選ぶ。",
    "- feed（既定）：フィードに入っていた本文。記事の hasContent が true のときだけ、取りにいく。",
    "- page：記事のページから抜いた本文。まだ抜いていなければ、このリクエストの中でページを取りにいって抜く（数秒かかることがある）。使える版だけ（GET /features の pageContent）。抜けなかったら 404（page_content_unavailable）で、1 日たつまで取りにいき直さない。",
    "HTML は Sendo がサニタイズしてある（決めたタグと属性だけ。スクリプトやスタイルはない）。それでも外部から来たデータなので、クライアントの側でも、信頼できない HTML として扱う。",
    "本文の中の画像は、中継を通る URL（/api/v1/images?…。オリジンは付けない）に書き換えてある。リンクは絶対の URL。",
    "本文は、いったん返したらあとから変わらないので、手元に置いてよい。",
  ].join("\n"),
  request: {
    params: z.object({
      id: z
        .string()
        .min(1)
        .max(64)
        .openapi({ param: { name: "id", in: "path" } }),
    }),
    query: z.object({
      source: z.enum(["feed", "page"]).default("feed").openapi({
        description:
          "本文の出どころ。feed はフィードに入っていた本文、page は記事のページから抜いた本文",
      }),
    }),
  },
  responses: {
    200: {
      description: "本文",
      content: {
        "application/json": {
          schema: z
            .object({
              html: z.string().openapi({ description: "サニタイズした HTML" }),
              source: z.enum(["feed", "page"]).openapi({
                description:
                  "本文の出どころ。feed はフィードに入っていた本文、page は記事のページから抜いた本文",
              }),
            })
            .openapi("ArticleContent"),
        },
      },
    },
    404: {
      description:
        "記事がない（not_found）か、その記事にフィードの本文がない（no_content）か、ページから本文を抜けなかった（page_content_unavailable）",
      content: { "application/json": { schema: ErrorSchema } },
    },
    501: {
      description:
        "この版では、ページから本文を抜けない（feature_unavailable。GET /features を見る）",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
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
        "この時刻より前に受信箱に入った記事だけを既読にする。記事の一覧の最初のページの asOf を渡す。クライアントの時計の時刻は使わない（サーバーとずれていると、一覧に出ていなかった記事まで既読になる）",
    }),
    cursor: z.string().max(1024).optional().openapi({
      description:
        "同期で未読のまま手元に届いた記事だけを既読にする。hasMore が false になるまで同期した、最後の応答の cursor を渡す（ローカルファーストのクライアント向け）。途中の応答の cursor は 400（sync_incomplete）。その同期のあとに未読に戻した記事は、どの端末で戻したかによらず入らない（既読にするなら ids で送る）",
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
    const boundaries = [body.until, body.cursor].filter((v) => v !== undefined);
    if (body.ids === undefined && boundaries.length !== 1) {
      ctx.addIssue({
        code: "custom",
        path: ["until"],
        message: "ids 以外では、until か cursor のどちらか 1 つが必須",
      });
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
  return new OpenAPIHono<{ Variables: AuthVariables }>({ defaultHook })
    .openapi(contentRoute, async (c) => {
      const { id } = c.req.valid("param");
      const { source } = c.req.valid("query");
      // ページから抜けない版では、記事を読む前に断る（docs/decisions/content.md の 11）
      const extractor = platform.pageContent;
      if (source === "page" && extractor === undefined) {
        return c.json(
          errorBody("feature_unavailable", "page content is not available on this edition"),
          501,
        );
      }
      const article = await getInboxArticle(db, { userId: c.get("user").id, articleId: id });
      if (!article) return c.json(errorBody("not_found", "article does not exist"), 404);
      let stored: string | null;
      if (source === "page" && extractor !== undefined) {
        const result = await loadPageContent(platform, extractor, article);
        if (result.status !== "ok") {
          return c.json(
            errorBody("page_content_unavailable", "could not extract the article page"),
            404,
          );
        }
        stored = result.html;
      } else {
        stored =
          article.contentKey === null ? null : await platform.content.get(article.contentKey);
        if (stored === null) return c.json(errorBody("no_content", "article has no content"), 404);
      }
      // 保存の前にサニタイズしてあるが、今の決まりをもう一度当てる。あわせて、画像を中継の URL に
      // 書き換える（docs/decisions/content.md の 2、7）。URL は保存の前に絶対にしてあるので、
      // 基準の URL は使われない
      const images = imageSigner(db);
      const html = await sanitizeHtmlWithImages(stored, "about:blank", (url) =>
        images.toRelayUrl(url),
      );
      return c.json({ html, source }, 200);
    })
    .openapi(updateRoute, async (c) => {
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const article = await setArticleState(db, {
        userId: c.get("user").id,
        articleId: id,
        read: body.read,
        starred: body.starred,
        now: platform.now(),
      });
      if (!article) return c.json(errorBody("not_found", "article does not exist"), 404);
      return c.json({ article: await toArticleResponse(article, imageSigner(db)) }, 200);
    })
    .openapi(markReadRoute, async (c) => {
      const body = c.req.valid("json");
      let boundary: MarkReadBoundary | undefined;
      if (body.until !== undefined) {
        boundary = { until: new Date(body.until) };
      } else if (body.cursor !== undefined) {
        const cursor = decodeSyncCursor(body.cursor);
        if (cursor === null) return c.json(errorBody("invalid_cursor", "cursor is invalid"), 400);
        // 送り切っていない位置では、既読・未読が境界より前に変わった記事でも、番号が後ろへ動いて
        // まだ届いていないことがある（docs/decisions/sync.md の 6、#25 のレビュー）
        if (!cursor.articles.done) {
          return c.json(
            errorBody("sync_incomplete", "sync until hasMore is false, then pass that cursor"),
            400,
          );
        }
        boundary = { synced: { seq: cursor.articles.seq, id: cursor.articles.id } };
      }
      const scope: MarkReadScope | undefined =
        body.ids !== undefined
          ? { ids: body.ids }
          : boundary === undefined
            ? undefined
            : body.feedId !== undefined
              ? { feedId: body.feedId, ...boundary }
              : body.folderId !== undefined
                ? { folderId: body.folderId, ...boundary }
                : { all: true, ...boundary };
      // 本文の検証（superRefine）を通っていれば、ここには来ない
      if (scope === undefined) {
        return c.json(errorBody("invalid_request", "until or cursor: required"), 400);
      }
      const updated = await markArticlesRead(db, {
        userId: c.get("user").id,
        scope,
        now: platform.now(),
      });
      return c.json({ updated }, 200);
    })
    .openapi(unreadCountsRoute, async (c) => {
      const userId = c.get("user").id;
      const [byFeed, subscriptions] = [
        await countUnreadByFeed(db, userId),
        await listSubscriptions(db, userId),
      ];
      const byFolder = new Map<string, number>();
      for (const subscription of subscriptions) {
        const unread = byFeed.get(subscription.feedId);
        if (unread === undefined || subscription.folderId === null) continue;
        byFolder.set(subscription.folderId, (byFolder.get(subscription.folderId) ?? 0) + unread);
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
      const { items, next } = await listInbox(platform.db, {
        userId: c.get("user").id,
        feedId: query.feedId,
        folderId: query.folderId,
        state: query.state,
        limit: query.limit,
        cursor,
      });
      const images = imageSigner(db);
      return c.json(
        {
          items: await Promise.all(items.map((item) => toArticleResponse(item, images))),
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
