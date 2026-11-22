import { eq } from "drizzle-orm";
import { getPageContent } from "../db/page-contents";
import { articles } from "../db/schema";
import { configureStorage, readStorageUsage } from "../db/storage";
import {
  ARTICLE_TRANSLATION_BYTES,
  countTranslateFailure,
  decideTranslations,
  failTranslating,
  finishBatchTranslation,
  finishTranslating,
  getTranslation,
  listArticleHolders,
  listBatchesToCheck,
  listBatchRows,
  markForBatch,
  releaseStaleBatchMarks,
  revertStaleTranslating,
  setBatchContentSource,
  setBatchId,
  skipEmptyBatchArticles,
  unmarkBatch,
  unmarkCheckedBatch,
} from "../db/translations";
import { sanitizeHtml } from "../lib/sanitize-html";
import { notifySync } from "../lib/sync-notify";
import {
  type Platform,
  type TranslationSegment,
  type Translator,
  TranslatorError,
} from "../platform";
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

type MaintainPlatform = Pick<
  Platform,
  "db" | "translator" | "syncUpdates" | "retentionConfig" | "content"
>;

/**
 * 訳文の行の手入れ（docs/decisions/translation.md の 1、4、7）。5 分おきの定期実行が積む。
 * 止まった翻訳を戻すのは、API キーがなくても行う。訳すかどうかを決めるのと、バッチで訳すのは、
 * キーがあるときだけ
 */
export async function maintainTranslations(
  platform: MaintainPlatform,
): Promise<{ reverted: number; decided: number; written: number; sent: number }> {
  // 戻したことは、決める前に知らせる（決めるところで落ちても、戻した記事の知らせを欠かない）
  const reverted = await revertStaleTranslating(platform.db);
  await notifyTranslationChanged(platform, reverted);
  const { translator } = platform;
  if (translator === undefined) {
    return { reverted: reverted.length, decided: 0, written: 0, sent: 0 };
  }
  const decided = await decideTranslations(platform.db);
  await notifyTranslationChanged(
    platform,
    decided.filter((row) => row.delivered).map((row) => row.articleId),
  );
  // 結果を先に書く（送るところで落ちても、返った訳文を書き損ねない）
  const written = await checkBatches(platform, translator);
  const sent = await sendBatch(platform, translator);
  return { reverted: reverted.length, decided: decided.length, written, sent };
}

/** 訳す記事のタイトル・要約と、本文の置き場の名前 */
function readArticle(platform: Pick<Platform, "db">, articleId: string) {
  return platform.db
    .select({ title: articles.title, summary: articles.summary, contentKey: articles.contentKey })
    .from(articles)
    .where(eq(articles.id, articleId))
    .get();
}

/**
 * queued の記事を、1 つのバッチにして送る（docs/decisions/translation.md の 4）。1 時間たっても
 * バッチの ID がない印は、先に外して待ちに戻す。容量が足りなければ送らない。送れなければ印を残し、
 * 1 時間たったら待ちに戻る（作れたかどうか分からないときに、2 回送らないため）
 *
 * @returns 送った記事の数
 */
async function sendBatch(platform: MaintainPlatform, translator: Translator): Promise<number> {
  const { db } = platform;
  await releaseStaleBatchMarks(db);
  const key = crypto.randomUUID();
  const ids = await markForBatch(db, key);
  if (ids.length === 0) return 0;
  const requests: { id: string; segments: TranslationSegment[] }[] = [];
  const empty: string[] = [];
  let bodyBytes = 0;
  for (const id of ids) {
    const article = await readArticle(platform, id);
    const body =
      article === undefined ? null : await bodyToTranslate(platform, id, article.contentKey);
    const segments = [
      ...(article === undefined ? [] : segmentsOf(article)),
      ...(body?.segments.segments ?? []),
    ];
    if (segments.length === 0) {
      empty.push(id);
      continue;
    }
    if (body !== null) {
      // 結果を組み立てるときに、同じ本文で分け直す
      await setBatchContentSource(db, id, key, body.source);
      bodyBytes += new TextEncoder().encode(body.html).length;
    }
    requests.push({ id, segments });
  }
  // 訳すものがない記事は、訳せないものとして待ちから外す
  const skipped = await skipEmptyBatchArticles(db, key, empty);
  await notifyTranslationChanged(platform, skipped);
  if (requests.length === 0) return 0;
  const all = requests.flatMap((request) => request.segments);
  if (!(await hasRoomForTranslation(platform, all, bodyBytes))) {
    await unmarkBatch(db, key);
    return 0;
  }
  let batchId: string;
  try {
    batchId = await translator.createBatch(requests);
  } catch (error) {
    console.warn("could not send a translation batch", {
      articles: requests.length,
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }
  await setBatchId(db, key, batchId);
  return requests.length;
}

/**
 * 送ったバッチを、古い順に見にいき、終わっていれば結果を書く（docs/decisions/translation.md の 4）。
 * 見にいけなければ印を残す。訳せなかった記事と、結果のない記事は、印を外して待ちに戻す。容量が
 * 足りずに書けなかった記事は、印を残して次の定期実行で書き直す
 *
 * @returns 訳文を書いた記事の数
 */
async function checkBatches(platform: MaintainPlatform, translator: Translator): Promise<number> {
  const { db } = platform;
  // 書く文の容量のトリガーが、今の上限で確かめるようにする（docs/decisions/translation.md の 12）
  await configureStorage(db, platform.retentionConfig.maxBytes);
  let count = 0;
  for (const batchId of await listBatchesToCheck(db)) {
    let status: Awaited<ReturnType<Translator["checkBatch"]>>;
    try {
      status = await translator.checkBatch(batchId);
    } catch (error) {
      console.warn("could not check a translation batch", {
        batchId,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (status.status === "in_progress") continue;
    if (status.status === "gone") {
      await unmarkCheckedBatch(db, batchId);
      continue;
    }
    const rows = new Map((await listBatchRows(db, batchId)).map((row) => [row.articleId, row]));
    const written: string[] = [];
    const keep: string[] = [];
    for (const result of status.results) {
      const row = rows.get(result.id);
      if (row === undefined || result.status !== "translated") continue;
      const article = await readArticle(platform, result.id);
      if (article === undefined) continue;
      const body =
        row.contentSource === null
          ? null
          : await bodyToTranslate(platform, result.id, article.contentKey, row.contentSource);
      // 返ってこなかった断片は、原文のまま残す（docs/decisions/translation.md の 10）
      const translated = new Map(result.segments.map((s) => [s.id, s.text]));
      const ok = await finishBatchTranslation(db, {
        articleId: result.id,
        batchId,
        title: article.title == null ? null : (translated.get("title") ?? article.title),
        summary: article.summary == null ? null : (translated.get("summary") ?? article.summary),
        content: body === null ? null : assembleBody(body, translated),
        model: result.model,
      });
      if (ok) {
        written.push(result.id);
        continue;
      }
      // 行がまだそのバッチの印を持ち訳文がないなら、容量のトリガーが書かなかった。次に書き直す
      const current = await getTranslation(db, result.id);
      if (current?.batchId === batchId && current.translatedAt === null) keep.push(result.id);
    }
    await unmarkCheckedBatch(db, batchId, keep);
    await notifyTranslationChanged(platform, written);
    count += written.length;
  }
  return count;
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
 * （タイトルと要約だけを訳す）。source を渡すと、その出どころだけを読む（バッチの結果を、送ったときと
 * 同じ本文で組み立てる）
 */
async function bodyToTranslate(
  platform: Pick<Platform, "db" | "content">,
  articleId: string,
  contentKey: string | null,
  source?: "feed" | "page",
): Promise<Body | null> {
  const page = source === "feed" ? undefined : await getPageContent(platform.db, articleId);
  let stored: { source: "feed" | "page"; html: string } | null = null;
  if (page?.html != null) stored = { source: "page", html: page.html };
  else if (contentKey !== null && source !== "page") {
    const feed = await platform.content.get(contentKey);
    if (feed !== null) stored = { source: "feed", html: feed };
  }
  if (stored === null) return null;
  // 保存の前にサニタイズしてあるが、今の決まりをもう一度当ててから分ける（URL は絶対にしてある）
  const html = sanitizeHtml(stored.html, "about:blank");
  let segments: BodySegments;
  try {
    segments = splitBody(html);
  } catch (error) {
    // 本文を分けられなくても、タイトルと要約は訳す
    console.warn("could not split the article body for translation", {
      articleId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
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
  const article = await readArticle(platform, articleId);
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
