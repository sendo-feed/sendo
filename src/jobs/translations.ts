import { eq } from "drizzle-orm";
import { getPageContent } from "../db/page-contents";
import { articles } from "../db/schema";
import { configureStorage, readStorageUsage } from "../db/storage";
import {
  ARTICLE_TRANSLATION_BYTES,
  countTranslateFailure,
  decideTranslations,
  failTranslating,
  finishTranslating,
  getTranslation,
  listArticleHolders,
  revertStaleTranslating,
} from "../db/translations";
import { sanitizeHtml } from "../lib/sanitize-html";
import { notifySync } from "../lib/sync-notify";
import { type Platform, type TranslationSegment, TranslatorError } from "../platform";
import { type BodySegments, splitBody } from "../translation/segments";

/** 本文から送る文の合計の上限（Unicode の文字。docs/decisions/translation.md の 3） */
export const MAX_TRANSLATED_BODY_CHARS = 60_000;

/** 訳した本文（サニタイズしたあと）の大きさの上限（同じく 3） */
export const MAX_TRANSLATED_BODY_BYTES = 256 * 1024;

/**
 * 記事の翻訳が変わったことを、その記事を受信箱に持つ人に知らせる（docs/decisions/sync.md の 9、10）。
 * 受信箱の行の番号は、訳文の表のトリガーが振っている。訳文は記事ごとの共有のデータなので、
 * 求めた人だけでなく、持つ人すべてに知らせる
 */
export async function notifyTranslationChanged(
  platform: Pick<Platform, "db" | "syncUpdates">,
  articleIds: readonly string[],
): Promise<void> {
  if (articleIds.length === 0) return;
  // 知らせは欠けてもよい（クライアントは定期同期も続ける）。相手を読めなくても、済んだ書き込みや
  // 応答を失敗にしない（lib/sync-notify.ts）
  let userIds: string[];
  try {
    userIds = await listArticleHolders(platform.db, articleIds);
  } catch {
    console.warn("could not read whom to notify of translation changes");
    return;
  }
  await notifySync(platform.syncUpdates.notify, userIds);
}

/**
 * 訳文の行の手入れ（docs/decisions/translation.md の 1、7）。5 分おきの定期実行が積む。
 * 止まった翻訳を戻すのは、API キーがなくても行う。訳すかどうかを決めるのは、キーがあるときだけ
 */
export async function maintainTranslations(
  platform: Pick<Platform, "db" | "translator" | "syncUpdates">,
): Promise<{ reverted: number; decided: number }> {
  // 戻したことは、決める前に知らせる（決めるところで落ちても、戻した記事の知らせを欠かない）
  const reverted = await revertStaleTranslating(platform.db);
  await notifyTranslationChanged(platform, reverted);
  const decided = platform.translator === undefined ? [] : await decideTranslations(platform.db);
  await notifyTranslationChanged(
    platform,
    decided.filter((row) => row.delivered).map((row) => row.articleId),
  );
  return { reverted: reverted.length, decided: decided.length };
}

/**
 * 訳したあとの大きさの見積もり。日本語は UTF-8 で 1 文字 3 バイトなので、送る文は入力の倍とみる。
 * 本文は、送らないタグや URL の分（もとの HTML の大きさ）も足す
 */
function estimateTranslationBytes(
  segments: readonly TranslationSegment[],
  bodyHtmlBytes = 0,
): number {
  const input = segments.reduce((sum, s) => sum + new TextEncoder().encode(s.text).length, 0);
  return ARTICLE_TRANSLATION_BYTES + input * 2 + bodyHtmlBytes;
}

/**
 * 容量が足りるか（docs/decisions/translation.md の 12）。送る前と呼ぶ前に確かめる
 */
export async function hasRoomForTranslation(
  platform: Pick<Platform, "db" | "retentionConfig">,
  segments: readonly TranslationSegment[],
  bodyHtmlBytes = 0,
): Promise<boolean> {
  await configureStorage(platform.db, platform.retentionConfig.maxBytes);
  const usage = await readStorageUsage(platform.db);
  return usage.bytes + estimateTranslationBytes(segments, bodyHtmlBytes) <= usage.limitBytes;
}

/** 訳す本文。ページの本文が抜けていればそれ、なければフィードの本文（決定の 3） */
interface Body {
  source: "feed" | "page";
  html: string;
  segments: BodySegments;
}

/**
 * 訳す本文を読み、断片に分ける。本文がない記事と、送る文の合計が上限を超える記事は null
 * （タイトルと要約だけを訳す）
 */
async function bodyToTranslate(
  platform: Pick<Platform, "db" | "content">,
  articleId: string,
  contentKey: string | null,
): Promise<Body | null> {
  const page = await getPageContent(platform.db, articleId);
  let stored: { source: "feed" | "page"; html: string } | null = null;
  if (page?.html != null) stored = { source: "page", html: page.html };
  else if (contentKey !== null) {
    const feed = await platform.content.get(contentKey);
    if (feed !== null) stored = { source: "feed", html: feed };
  }
  if (stored === null) return null;
  // 保存の前にサニタイズしてあるが、今の決まりをもう一度当ててから分ける（URL は絶対にしてある）
  const html = sanitizeHtml(stored.html, "about:blank");
  const segments = splitBody(html);
  if (segments.segments.length === 0 || segments.length > MAX_TRANSLATED_BODY_CHARS) return null;
  return { source: stored.source, html, segments };
}

/**
 * 訳から本文を組み立て、もう一度サニタイズする（決定の 10）。上限を超えたら null（本文を置かない）
 */
function assembleBody(
  body: Body,
  translated: ReadonlyMap<string, string>,
): { html: string; source: "feed" | "page" } | null {
  const html = sanitizeHtml(body.segments.assemble(translated), "about:blank");
  if (new TextEncoder().encode(html).length > MAX_TRANSLATED_BODY_BYTES) return null;
  return { html, source: body.source };
}

/** 訳す断片（タイトルと要約）。空のものは送らない */
export function segmentsOf(article: {
  title: string | null;
  summary: string | null;
}): TranslationSegment[] {
  const segments: TranslationSegment[] = [];
  if (article.title?.trim()) segments.push({ id: "title", text: article.title });
  if (article.summary?.trim()) segments.push({ id: "summary", text: article.summary });
  return segments;
}

/**
 * その場の翻訳の仕事（docs/decisions/translation.md の 5、8）。始めた時刻が今の行と同じときだけ動く。
 *
 * やり直せる失敗は、行の回数を 1 つ数えてから例外を投げ、仕事の表にやり直させる。3 回目で
 * untranslated に戻す。拒否・上限で切れた応答・読めない応答・要求の形の誤りは、すぐに戻す
 */
export async function runTranslateArticle(
  platform: Pick<Platform, "db" | "translator" | "retentionConfig" | "syncUpdates" | "content">,
  articleId: string,
  startedAt: Date,
): Promise<void> {
  // やり直せる失敗で例外を投げるときは、回数しか変えていないので知らせない
  if (await translateArticle(platform, articleId, startedAt)) {
    await notifyTranslationChanged(platform, [articleId]);
  }
}

/** @returns 行の状態を変えたら true */
async function translateArticle(
  platform: Pick<Platform, "db" | "translator" | "retentionConfig" | "content">,
  articleId: string,
  startedAt: Date,
): Promise<boolean> {
  const { db, translator } = platform;
  const row = await getTranslation(db, articleId);
  if (row?.status !== "translating" || row.startedAt?.getTime() !== startedAt.getTime()) {
    return false;
  }
  if (translator === undefined) {
    // キーを外した
    return failTranslating(db, articleId, startedAt);
  }
  const article = await db
    .select({ title: articles.title, summary: articles.summary, contentKey: articles.contentKey })
    .from(articles)
    .where(eq(articles.id, articleId))
    .get();
  const body =
    article === undefined ? null : await bodyToTranslate(platform, articleId, article.contentKey);
  const segments = [
    ...(article === undefined ? [] : segmentsOf(article)),
    ...(body?.segments.segments ?? []),
  ];
  const bodyBytes = body === null ? 0 : new TextEncoder().encode(body.html).length;
  if (segments.length === 0 || !(await hasRoomForTranslation(platform, segments, bodyBytes))) {
    return failTranslating(db, articleId, startedAt);
  }

  let result: Awaited<ReturnType<typeof translator.translate>>;
  try {
    result = await translator.translate(segments);
  } catch (error) {
    if (error instanceof TranslatorError && !error.retryable) {
      console.warn("translation request was rejected", { articleId, error: error.message });
      return failTranslating(db, articleId, startedAt);
    }
    const outcome = await countTranslateFailure(db, articleId, startedAt);
    if (outcome === "retry") throw error;
    console.warn("translation failed; giving up", {
      articleId,
      error: error instanceof Error ? error.message : String(error),
    });
    return outcome === "failed";
  }
  if (result.status !== "translated") {
    console.warn("translation was not usable", { articleId, status: result.status });
    return failTranslating(db, articleId, startedAt);
  }
  // 返ってこなかった断片は、原文のまま残す（docs/decisions/translation.md の 10）
  const translated = new Map(result.segments.map((s) => [s.id, s.text]));
  const written = await finishTranslating(db, {
    articleId,
    startedAt,
    title: article?.title == null ? null : (translated.get("title") ?? article.title),
    summary: article?.summary == null ? null : (translated.get("summary") ?? article.summary),
    content: body === null ? null : assembleBody(body, translated),
    model: result.model,
  });
  if (written) return true;
  // 行がまだ同じなら、容量のトリガーが書かなかった。呼び直さずに戻す（決定の 12）
  return failTranslating(db, articleId, startedAt);
}
