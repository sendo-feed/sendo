import { z } from "zod";
import { MAX_FOLDER_NAME_LENGTH } from "../db/folders";
import { MAX_URL_LENGTH } from "../opml";

/** 記事を指定した言語の判定の仕事 1 つに入れる記事の数（docs/decisions/jobs.md の 4、13） */
export const LANGUAGE_ARTICLES_PER_JOB = 10;

/**
 * インポートを 1 つのジョブで処理する件数。
 *
 * 1 つの仕事が扱う量を抑える（docs/decisions/jobs.md の 4）。1 件ずつ別のフォルダに入れ直す最悪の
 * 場合でも、フォルダの作成と検索（2）、フィードの登録（2）、フォルダの割り当て（件数分）で 14 クエリで済む
 */
export const IMPORT_CHUNK_SIZE = 10;

/**
 * キューに流す仕事。表に積んだ中身は、取り出す側で必ず検証する（壊れた行や古い形の仕事を動かさない）。
 * 種類を足すときは、ここに足して runJob（index.ts）で受ける。
 */
export const jobSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("fetch-feed"), feedId: z.string().min(1) }),
  z.object({ type: z.literal("fetch-discord"), feedId: z.string().min(1) }),
  /** 1 日 1 回の片付け（docs/decisions/retention.md の 4、5）。定期実行が積む */
  z.object({ type: z.literal("clean-up") }),
  z.object({ type: z.literal("index-article-search") }),
  /**
   * 未処理・古い版の言語判定を小分けに進める。定期実行と起動時に積む。articleIds があれば、その記事
   * だけ（取り込んだとき、ページを抜き終えたとき。docs/decisions/jobs.md の 13）
   */
  z.object({
    type: z.literal("detect-article-languages"),
    articleIds: z.array(z.string().min(1)).min(1).max(LANGUAGE_ARTICLES_PER_JOB).optional(),
    after: z
      .object({
        articleId: z.string().min(1),
        source: z.enum(["feed", "page", "metadata"]),
      })
      .optional(),
  }),
  /**
   * 訳文の行の手入れ（docs/decisions/translation.md の 1、7）。止まった翻訳を戻し、API キーがあれば
   * 訳すかどうかを決める。定期実行が 5 分おきに積む
   */
  z.object({ type: z.literal("maintain-translations") }),
  /**
   * 指定した記事について、訳すかどうかを決める（判定を保存したとき、ページを抜けなかったと記録した
   * とき。docs/decisions/jobs.md の 13）
   */
  z.object({
    type: z.literal("decide-translations"),
    articleIds: z.array(z.string().min(1)).min(1).max(LANGUAGE_ARTICLES_PER_JOB),
  }),
  /**
   * その場の翻訳と訳し直し（docs/decisions/translation.md の 5、6）。startedAt は行の始めた時刻
   * （ミリ秒）。retranslation なら訳し直し（Opus で訳し、訳し直しの印を付ける）
   */
  z.object({
    type: z.literal("translate-article"),
    articleId: z.string().min(1),
    startedAt: z.int().nonnegative(),
    retranslation: z.boolean().optional(),
  }),
  /**
   * ベルの通知の行 1 つを、端末 1 つに送る（docs/decisions/web-push.md の 5）。取得の仕事が、
   * 送る行を作ったときに積む。中身は送るときに組み立てる
   */
  z.object({
    type: z.literal("send-bell-notification"),
    notificationId: z.string().min(1),
    registrationId: z.string().min(1),
  }),
  /**
   * 1 つの窓のまとめを作って送る（docs/decisions/notifications.md の 13）。取得の仕事が、窓の最初の
   * bundled の通知の記事の行を作ったときに、窓が閉じる時刻を指定して積む。windowStart は窓の
   * 始まり（ミリ秒）
   */
  z.object({
    type: z.literal("bundle-bell-notifications"),
    userId: z.string().min(1),
    bellId: z.string().min(1),
    windowStart: z.int().nonnegative(),
  }),
  /** 記事のページから本文を抜く（docs/decisions/content.md の 10）。取得の仕事のあとで積む */
  z.object({ type: z.literal("extract-page"), articleId: z.string().min(1) }),
  z.object({
    type: z.literal("import-feeds"),
    /** 誰の購読としてインポートするか */
    userId: z.string().min(1),
    feeds: z
      .array(
        z.object({
          url: z.string().min(1).max(MAX_URL_LENGTH),
          folder: z.string().min(1).max(MAX_FOLDER_NAME_LENGTH).nullable(),
        }),
      )
      .min(1)
      .max(IMPORT_CHUNK_SIZE),
  }),
]);

export type Job = z.infer<typeof jobSchema>;
