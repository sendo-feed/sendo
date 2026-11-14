import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { INITIAL_CURSOR, readChanges, type SyncCursor, type SyncPosition } from "../db/sync";
import type { Platform } from "../platform";
import type { AuthVariables } from "./auth";
import { defaultHook } from "./hook";
import { ArticleSchema, ErrorSchema, errorBody, toArticleResponse } from "./schemas";

/*
 * 差分同期の API（docs/decisions/sync.md）。
 */

/** カーソルの形の版。形を変えたら上げ、古い版のカーソルには最初から同期し直させる */
const CURSOR_VERSION = 1;

const PositionSchema = z.tuple([
  z.int().nonnegative(),
  z.string().max(64).nullable(),
  z.int().min(-1).nullable(),
]);
const CursorSchema = z.object({
  v: z.literal(CURSOR_VERSION),
  f: PositionSchema,
  s: PositionSchema,
  a: PositionSchema,
});

const toTuple = (p: SyncPosition) => [p.seq, p.id, p.upTo] as const;
const fromTuple = ([seq, id, upTo]: z.infer<typeof PositionSchema>): SyncPosition => ({
  seq,
  id,
  upTo,
});

/** カーソルを、URL にそのまま載せられる文字列にする（中身に意味を持たせない） */
export function encodeSyncCursor(cursor: SyncCursor): string {
  const json = JSON.stringify({
    v: CURSOR_VERSION,
    f: toTuple(cursor.folders),
    s: toTuple(cursor.subscriptions),
    a: toTuple(cursor.articles),
  });
  const bytes = new TextEncoder().encode(json);
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

/** 文字列からカーソルに戻す。読めなければ null */
export function decodeSyncCursor(value: string): SyncCursor | null {
  try {
    const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
    const json = new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
    const parsed = CursorSchema.safeParse(JSON.parse(json));
    if (!parsed.success) return null;
    return {
      folders: fromTuple(parsed.data.f),
      subscriptions: fromTuple(parsed.data.s),
      articles: fromTuple(parsed.data.a),
    };
  } catch {
    return null;
  }
}

const deleted = z.boolean().openapi({
  description: "消した印。true なら、手元からも消す（ほかの項目は最後の状態）",
});

const SyncFolderSchema = z
  .object({ id: z.string(), name: z.string(), createdAt: z.iso.datetime(), deleted })
  .openapi("SyncFolder");

const SyncFeedSchema = z
  .object({
    id: z.string().openapi({ description: "フィードの ID" }),
    url: z.string(),
    title: z.string().nullable(),
    siteUrl: z.string().nullable(),
    folderId: z.string().nullable(),
    createdAt: z.iso.datetime().openapi({ description: "購読した時刻" }),
    deleted: deleted.openapi({
      description:
        "購読をやめた印。true なら、そのフィードの記事をスターの付いたものを除いて手元から消す",
    }),
  })
  .openapi("SyncFeed");

const syncRoute = createRoute({
  method: "get",
  path: "/sync",
  summary: "前回の同期からの差分を取る",
  description: [
    "カーソルなしで呼ぶと、最初の同期を始める（消した印の付いていないフォルダと購読、未読・スター・直近 30 日の記事）。",
    "応答の cursor を次に渡すと、そのあとに変わったものだけを返す。hasMore が true なら、すぐにもう一度呼ぶ。",
    "配列は変更番号の順に並んでいる。同じ id が続けて来たら、後のものを採る。",
    "cursor の中身には意味を持たせていないので、クライアントはそのまま送り返すだけにする。",
  ].join("\n"),
  request: {
    query: z.object({
      cursor: z.string().max(1024).optional().openapi({ description: "前回の応答の cursor" }),
    }),
  },
  responses: {
    200: {
      description: "差分",
      content: {
        "application/json": {
          schema: z
            .object({
              cursor: z.string(),
              hasMore: z.boolean(),
              folders: z.array(SyncFolderSchema),
              feeds: z.array(SyncFeedSchema),
              articles: z.array(ArticleSchema),
            })
            .openapi("SyncChanges"),
        },
      },
    },
    400: {
      description: "カーソルが読めない（最初から同期し直す）",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

export function syncApi(platform: Platform) {
  return new OpenAPIHono<{ Variables: AuthVariables }>({ defaultHook }).openapi(
    syncRoute,
    async (c) => {
      const raw = c.req.valid("query").cursor;
      const cursor = raw === undefined ? INITIAL_CURSOR : decodeSyncCursor(raw);
      if (cursor === null) {
        return c.json(errorBody("invalid_cursor", "cursor is invalid; start over without it"), 400);
      }

      const changes = await readChanges(platform.db, {
        userId: c.get("user").id,
        cursor,
        now: platform.now(),
      });
      return c.json(
        {
          cursor: encodeSyncCursor(changes.cursor),
          hasMore: changes.hasMore,
          folders: changes.folders.map((folder) => ({
            id: folder.id,
            name: folder.name,
            createdAt: folder.createdAt.toISOString(),
            deleted: folder.deletedAt !== null,
          })),
          feeds: changes.subscriptions.map((subscription) => ({
            id: subscription.feedId,
            url: subscription.feed.url,
            title: subscription.feed.title,
            siteUrl: subscription.feed.siteUrl,
            folderId: subscription.folderId,
            createdAt: subscription.createdAt.toISOString(),
            deleted: subscription.deletedAt !== null,
          })),
          articles: changes.articles.map(toArticleResponse),
        },
        200,
      );
    },
  );
}
