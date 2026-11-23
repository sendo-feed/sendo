import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { imageSigner } from "../db/secrets";
import {
  INITIAL_CURSOR,
  INITIAL_POSITION,
  isCursorExpired,
  readChanges,
  type SyncCursor,
  type SyncPosition,
} from "../db/sync";
import type { Platform } from "../platform";
import type { AuthVariables } from "./auth";
import { defaultHook } from "./hook";
import { SavedPageIdSchema, SavedPageSchema, toSavedPageResponse } from "./saved";
import {
  ArticleSchema,
  ErrorSchema,
  errorBody,
  FeedDisplayNameSchema,
  FeedErrorCodeSchema,
  FeedIconUrlSchema,
  FeedRelocationCandidateSchema,
  FeedStatusSchema,
  SettingValueSchema,
  TRANSLATION_MODEL_DESCRIPTION,
  toArticleResponse,
  toFeedHealthResponse,
  translationEffortSchema,
} from "./schemas";

/*
 * 差分同期の API（docs/decisions/sync.md）。
 */

/** カーソルの形の版。形を変えたら上げ、古い版のカーソルには最初から同期し直させる */
const CURSOR_VERSION = 1;

const PositionSchema = z.tuple([
  z.int().nonnegative(),
  z.string().max(64).nullable(),
  z.int().min(-1).nullable(),
  z.boolean(),
]);
const CursorSchema = z.object({
  v: z.literal(CURSOR_VERSION),
  f: PositionSchema,
  s: PositionSchema,
  a: PositionSchema,
  // 設定を足す前に作られたカーソルには、ない。そのときは、設定だけを最初から送る
  // （全体を同期し直させない。docs/decisions/settings.md の 4）
  c: PositionSchema.optional(),
  p: PositionSchema.optional(),
});

const toTuple = (p: SyncPosition) => [p.seq, p.id, p.upTo, p.done] as const;
const fromTuple = ([seq, id, upTo, done]: z.infer<typeof PositionSchema>): SyncPosition => ({
  seq,
  id,
  upTo,
  done,
});

/** カーソルを、URL にそのまま載せられる文字列にする（中身に意味を持たせない） */
export function encodeSyncCursor(cursor: SyncCursor): string {
  const json = JSON.stringify({
    v: CURSOR_VERSION,
    f: toTuple(cursor.folders),
    s: toTuple(cursor.subscriptions),
    a: toTuple(cursor.articles),
    c: toTuple(cursor.settings),
    ...(cursor.savedPages && { p: toTuple(cursor.savedPages) }),
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
      settings: parsed.data.c ? fromTuple(parsed.data.c) : INITIAL_POSITION,
      ...(parsed.data.p && { savedPages: fromTuple(parsed.data.p) }),
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
    displayName: FeedDisplayNameSchema,
    status: FeedStatusSchema,
    lastErrorCode: FeedErrorCodeSchema,
    relocationCandidate: FeedRelocationCandidateSchema,
    siteUrl: z.string().nullable(),
    iconUrl: FeedIconUrlSchema,
    folderId: z.string().nullable(),
    createdAt: z.iso.datetime().openapi({ description: "購読した時刻" }),
    deleted: deleted.openapi({
      description:
        "購読をやめた印。true なら、手元の購読を消す。記事は消さない（受信箱から消えた記事は、articles に deleted: true で届く）",
    }),
  })
  .openapi("SyncFeed");

const SyncTranslationFailureSchema = z
  .object({
    kind: z.enum(["refused", "failed"]).openapi({
      description:
        "refused は Claude が訳すことを拒否した（stop_reason が refusal）、failed はそのほかの失敗（上限で切れた・読めない応答、回数切れ、容量、送るものがなかった、止まった翻訳を戻した など）",
    }),
    category: z.string().nullable().openapi({
      description:
        "拒否の種類（拒否の応答の stop_details.category。cyber、bio など）。拒否でないときと、拒否の応答に種類がないときは null",
    }),
    stage: z.enum(["batch", "on_demand"]).openapi({
      description:
        "どこで訳せなかったか。batch は自動のまとめた翻訳、on_demand は求めたその場の翻訳",
    }),
  })
  .openapi("SyncArticleTranslationFailure");

const SyncTranslationSchema = z
  .object({
    language: z.string().openapi({
      description: "訳すかどうかを決めたときの、記事の主言語（ISO 639-1。判定できなければ und）",
    }),
    status: z.enum(["queued", "translating", "translated", "untranslated"]).openapi({
      description:
        "翻訳の状態。queued は自動の翻訳を待っている、translating は訳している（訳し直しの最中は、もとの訳文があり translatedAt も付く）、translated は訳文がある、untranslated は訳せなかった（求めればその場で訳せる）",
    }),
    title: z.string().nullable().openapi({
      description:
        "訳したタイトル（プレーンテキスト。表示する側でエスケープする）。訳文がなければ null",
    }),
    summary: z.string().nullable().openapi({
      description: "訳した要約（プレーンテキスト）。訳文がなければ null",
    }),
    translatedAt: z.iso.datetime().nullable().openapi({
      description:
        "訳した時刻。訳文がなければ null。変わったら、手元の訳した本文を GET /articles/{id}/translation で取り直す",
    }),
    retranslated: z.boolean().openapi({
      description:
        "Opus で訳し直したか（docs/decisions/translation.md の 6）。訳し直せるのは、translated で、これが false の記事だけ",
    }),
    failure: SyncTranslationFailureSchema.nullable().openapi({
      description:
        "訳せなかった理由（docs/decisions/translation.md の 17）。訳そうとして untranslated にした記事だけに付く。untranslated でない記事、言語が判定できなかった記事、訳すものがなく送らなかった記事、理由を残す前に untranslated になった記事は null",
    }),
    model: z
      .string()
      .nullable()
      .openapi({
        description: `${TRANSLATION_MODEL_DESCRIPTION}。訳文のない記事（translatedAt が null）は null。訳し直しの最中（translating）は、もとの訳文のモデル`,
        example: "claude-sonnet-5-5",
      }),
    effort: translationEffortSchema(
      "訳文のない記事（translatedAt が null）も null。訳し直しの最中（translating）は、もとの訳文の思考量",
    ),
  })
  .openapi("SyncArticleTranslation");

const SyncArticleSchema = z
  .union([
    ArticleSchema.extend({
      deleted: z.literal(false).openapi({ description: "受信箱にある記事" }),
      translation: SyncTranslationSchema.nullable().openapi({
        description:
          "Sendo の翻訳（docs/decisions/translation.md の 14）。訳さない記事（日本語の記事、Discord の投稿）と、訳すかどうかを決めていない記事（決める前の記事、取り込んでから 1 日のうちに決まらなかった記事、翻訳を使わない Sendo の記事）は null。翻訳が変わると、記事が差分としてもう一度届く",
      }),
    }).openapi("SyncInboxArticle"),
    z
      .object({
        id: z.string().openapi({ description: "記事の ID" }),
        deleted: z.literal(true).openapi({ description: "受信箱から消えた記事。手元から消す" }),
      })
      .openapi("SyncRemovedArticle"),
  ])
  .openapi("SyncArticle");

const settingKey = {
  deviceType: z.string().openapi({ description: "端末の種類（mobile ／ desktop）" }),
  name: z.string(),
};
const SyncSettingSchema = z
  .union([
    z
      .object({
        ...settingKey,
        value: SettingValueSchema,
        deleted: z.literal(false).openapi({ description: "置いてある項目" }),
      })
      .openapi("SyncPutSetting"),
    z
      .object({
        ...settingKey,
        deleted: z.literal(true).openapi({ description: "消した項目。手元から消す（既定に戻す）" }),
      })
      .openapi("SyncRemovedSetting"),
  ])
  .openapi("SyncSetting");

const SyncSavedPageSchema = z
  .union([
    SavedPageSchema.extend({ deleted: z.literal(false) }).openapi("SyncActiveSavedPage"),
    z.object({ id: SavedPageIdSchema, deleted: z.literal(true) }).openapi("SyncRemovedSavedPage"),
  ])
  .openapi("SyncSavedPage");

const syncRoute = createRoute({
  method: "get",
  path: "/sync",
  summary: "前回の同期からの差分を取る",
  description: [
    "カーソルなしで呼ぶと、最初の同期を始める（消した印の付いていないフォルダ・購読・設定、未読・スター・直近 30 日の記事）。",
    "応答の cursor を次に渡すと、そのあとに変わったものだけを返す。hasMore が true なら、すぐにもう一度呼ぶ。",
    "配列は変更番号の順に並んでいる。同じ id が続けて来たら、後のものを採る。",
    "deleted が true のものは手元から消す。手元の行を消すのは、その行の deleted が届いたときだけにする。購読をやめた（feeds の deleted）からといって、そのフィードの記事を消さない（配列ごとにページを送るので、配列をまたいだ順序は保証されない）。",
    "settings には、どの端末の種類の項目も届く。クライアントは、自分の種類の分だけを使えばよい。",
    "includeSaved=true なら、あとで読むページの新規保存と解除も savedPages に載せる。",
    "cursor の中身には意味を持たせていないので、クライアントはそのまま送り返すだけにする。",
  ].join("\n"),
  request: {
    query: z.object({
      includeSaved: z.enum(["true", "false"]).optional(),
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
              articles: z.array(SyncArticleSchema),
              settings: z.array(SyncSettingSchema),
              savedPages: z.array(SyncSavedPageSchema).optional(),
            })
            .openapi("SyncChanges"),
        },
      },
    },
    400: {
      description: "カーソルが読めないか、古すぎて消した記録を送れない（最初から同期し直す）",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

export function syncApi(platform: Platform) {
  return new OpenAPIHono<{ Variables: AuthVariables }>({ defaultHook }).openapi(
    syncRoute,
    async (c) => {
      const { cursor: raw, includeSaved } = c.req.valid("query");
      const decoded = raw === undefined ? INITIAL_CURSOR : decodeSyncCursor(raw);
      if (decoded === null) {
        return c.json(errorBody("invalid_cursor", "cursor is invalid; start over without it"), 400);
      }

      const cursor = {
        ...decoded,
        savedPages: includeSaved === "true" ? (decoded.savedPages ?? INITIAL_POSITION) : undefined,
      };
      const userId = c.get("user").id;
      const changes = await readChanges(platform.db, {
        userId,
        cursor,
        now: platform.now(),
      });
      // 消した記録の回収は、読んだあとで確かめる（isCursorExpired）
      if (raw !== undefined && (await isCursorExpired(platform.db, { userId, cursor }))) {
        return c.json(errorBody("invalid_cursor", "cursor is too old; start over without it"), 400);
      }
      const images = imageSigner(platform.db);
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
          feeds: await Promise.all(
            changes.subscriptions.map(async (subscription) => ({
              id: subscription.feedId,
              url: subscription.feed.url,
              title: subscription.feed.title,
              displayName: subscription.displayName,
              ...toFeedHealthResponse(subscription.feed),
              siteUrl: subscription.feed.siteUrl,
              iconUrl: await images.toRelayUrl(subscription.feed.iconUrl),
              folderId: subscription.folderId,
              createdAt: subscription.createdAt.toISOString(),
              deleted: subscription.deletedAt !== null,
            })),
          ),
          articles: await Promise.all(
            changes.articles.map(async (item) =>
              item.deleted
                ? { id: item.id, deleted: true as const }
                : {
                    ...(await toArticleResponse(item.article, images)),
                    deleted: false as const,
                    translation:
                      item.translation === null
                        ? null
                        : {
                            ...item.translation,
                            translatedAt: item.translation.translatedAt?.toISOString() ?? null,
                          },
                  },
            ),
          ),
          ...(changes.savedPages && {
            savedPages: changes.savedPages.map((item) =>
              item.deleted ? item : { ...toSavedPageResponse(item), deleted: false as const },
            ),
          }),
          settings: changes.settings.map((item) =>
            item.deleted
              ? { deviceType: item.deviceType, name: item.name, deleted: true as const }
              : {
                  deviceType: item.deviceType,
                  name: item.name,
                  value: JSON.parse(item.json) as unknown,
                  deleted: false as const,
                },
          ),
        },
        200,
      );
    },
  );
}
