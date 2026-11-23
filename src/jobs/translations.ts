import { eq } from "drizzle-orm";
import { getPageContent } from "../db/page-contents";
import { articles } from "../db/schema";
import { configureStorage, readStorageUsage } from "../db/storage";
import {
  ARTICLE_TRANSLATION_BYTES,
  COPY_BODY,
  COPY_SUMMARY,
  COPY_TITLE,
  copyRetranslation,
  countTranslateFailure,
  decideTranslations,
  failBatchArticles,
  failTranslating,
  findCopies,
  finishBatchTranslation,
  finishCopiedBatchArticle,
  finishCopiedTranslating,
  finishTranslating,
  getTranslation,
  listArticleHolders,
  listBatchesToCheck,
  listBatchRows,
  listRetranslationTargets,
  listUndecidedArticles,
  markForBatch,
  NO_BODY_HASH,
  releaseStaleBatchMarks,
  revertStaleTranslating,
  setBatchBody,
  setBatchId,
  skipEmptyBatchArticles,
  unmarkBatch,
  unmarkCheckedBatch,
} from "../db/translations";
import { sanitizeHtml } from "../lib/sanitize-html";
import { notifySync } from "../lib/sync-notify";
import {
  type BatchTranslationResult,
  type Platform,
  type TranslationSegment,
  type Translator,
  TranslatorError,
} from "../platform";
import { type BodySegments, splitBody } from "../translation/segments";
import { LANGUAGE_ARTICLES_PER_JOB } from "./job";

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
 * 指定した記事について、訳すかどうかを決めて行を作り、持つ人に知らせる（判定のあとの連鎖。
 * docs/decisions/jobs.md の 13、translation.md の 1）。API キーがなければ何もしない
 */
export async function runDecideTranslations(
  platform: Pick<Platform, "db" | "syncUpdates" | "translator">,
  articleIds: readonly string[],
): Promise<number> {
  if (platform.translator === undefined) return 0;
  const decided = await decideTranslations(platform.db, articleIds.length, articleIds);
  await notifyTranslationChanged(
    platform,
    decided.filter((row) => row.delivered).map((row) => row.articleId),
  );
  return decided.length;
}

/**
 * 訳すかどうかを決める仕事を、その記事について積む（判定を保存したとき、ページを抜けなかったと
 * 記録したとき。docs/decisions/jobs.md の 13）。API キーがあり、まだ訳文の行がなく、取り込んでから
 * 1 日以内の記事だけを 1 つの仕事にまとめる。積めなくても呼んだ側の処理は失敗にしない（5 分ごとの
 * 定期実行が拾う）
 */
export async function enqueueDecideTranslations(
  platform: Pick<Platform, "db" | "jobs" | "translator">,
  articleIds: readonly string[],
): Promise<void> {
  if (platform.translator === undefined || articleIds.length === 0) return;
  try {
    const undecided = await listUndecidedArticles(platform.db, [...new Set(articleIds)]);
    // 1 つの仕事に入れる記事の数には上限がある（jobs.md の 4）。多ければ分けて積む
    const jobs = [];
    for (let i = 0; i < undecided.length; i += LANGUAGE_ARTICLES_PER_JOB) {
      jobs.push({
        type: "decide-translations" as const,
        articleIds: undecided.slice(i, i + LANGUAGE_ARTICLES_PER_JOB),
      });
    }
    if (jobs.length > 0) await platform.jobs.enqueue(jobs);
  } catch (error) {
    console.warn("could not enqueue translation decisions; retrying at the next schedule", {
      error,
    });
  }
}

type MaintainPlatform = Pick<
  Platform,
  "db" | "translator" | "syncUpdates" | "retentionConfig" | "content"
>;

/**
 * 同じ元記事の、訳し直した訳を写し損ねた行に写し、その記事を持つ人に知らせる（docs/decisions/
 * translation.md の 16）。sourceId を渡したら、その行から写せる行だけ（訳し直した直後）。1 行ずつ
 * 写し、写す元と写す先の条件は写す文の中で確かめる。写せなかった行（容量、状態）は、次の定期実行で
 * また試す
 *
 * @returns 写した行の数
 */
export async function spreadRetranslations(
  platform: Pick<Platform, "db" | "syncUpdates">,
  sourceId?: string,
): Promise<number> {
  const copied: string[] = [];
  try {
    for (const articleId of await listRetranslationTargets(platform.db, { sourceId })) {
      if (await copyRetranslation(platform.db, articleId)) copied.push(articleId);
    }
  } finally {
    // 途中で落ちても、写した行は知らせる
    await notifyTranslationChanged(platform, copied);
  }
  return copied.length;
}

/**
 * 訳文の行の手入れ（docs/decisions/translation.md の 1、4、7、16）。5 分おきの定期実行が積む。
 * 止まった翻訳を戻すのと、訳し直しを写し直すのは、API キーがなくても行う（呼ばないため）。訳すか
 * どうかを決めるのと、バッチで訳すのは、キーがあるときだけ
 */
export async function maintainTranslations(platform: MaintainPlatform): Promise<{
  reverted: number;
  spread: number;
  decided: number;
  written: number;
  sent: number;
}> {
  // 戻したことは、決める前に知らせる（決めるところで落ちても、戻した記事の知らせを欠かない）
  const reverted = await revertStaleTranslating(platform.db);
  await notifyTranslationChanged(platform, reverted);
  // 写すところで落ちても、ほかの手入れを止めない（写し損ねた行は次の定期実行で写す）
  let spread = 0;
  try {
    spread = await spreadRetranslations(platform);
  } catch (error) {
    console.warn("could not spread retranslations; retrying at the next schedule", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const { translator } = platform;
  if (translator === undefined) {
    return { reverted: reverted.length, spread, decided: 0, written: 0, sent: 0 };
  }
  const decided = await decideTranslations(platform.db);
  await notifyTranslationChanged(
    platform,
    decided.filter((row) => row.delivered).map((row) => row.articleId),
  );
  // 結果を先に書く（送るところで落ちても、返った訳文を書き損ねない）
  const written = await checkBatches(platform, translator);
  const sent = await sendBatch(platform, translator);
  return { reverted: reverted.length, spread, decided: decided.length, written, sent };
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
  const copied: string[] = [];
  let bodyBytes = 0;
  for (const id of ids) {
    const article = await readArticle(platform, id);
    const body =
      article === undefined ? null : await bodyToTranslate(platform, id, article.contentKey);
    const bodyHash = await bodyFingerprint(body);
    // 同じ元記事から写せる部分は送らず、結果を書く文の中で写す（決定の 16）
    const copies =
      article === undefined ? 0 : copiesFor(article, await findCopies(db, id, bodyHash));
    const segments = [
      ...(article === undefined ? [] : segmentsOf(article, copies)),
      ...((copies & COPY_BODY) === 0 ? (body?.segments.segments ?? []) : []),
    ];
    if (segments.length === 0) {
      if (copies === 0 || article === undefined) {
        empty.push(id);
        continue;
      }
      // すべて写せる。送らずに、この文の中で写す元を選び直して写す。写す元がなくなっていた、容量が
      // 足りないときは、書かずに待ちに戻す
      const written = await finishCopiedBatchArticle(db, {
        articleId: id,
        key,
        copies,
        originalTitle: article.title,
        originalSummary: article.summary,
        bodySource: body?.source ?? null,
        bodyHash,
      });
      if (written) copied.push(id);
      else await unmarkBatch(db, key, [id]);
      continue;
    }
    // 結果を組み立てるときに、同じ本文で分け直し、送った断片と同じかを照らす。写す部分も覚えておく
    await setBatchBody(db, id, key, {
      source: body?.source ?? null,
      hash: body === null ? null : await segmentsHash(body.segments.segments),
      copies,
    });
    if (body !== null && (copies & COPY_BODY) === 0) {
      bodyBytes += new TextEncoder().encode(body.html).length;
    }
    requests.push({ id, segments });
  }
  await notifyTranslationChanged(platform, copied);
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
    // 断られた（認証、利用上限など）なら作られていないので、すぐ待ちに戻して次の定期実行で送る。
    // 届かない・時間切れは作れたか分からないので、印を残す（1 時間たったら待ちに戻る）
    if (error instanceof TranslatorError && error.responded) await unmarkBatch(db, key);
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
    try {
      count += await checkBatch(platform, translator, batchId);
    } catch (error) {
      // 1 つのバッチで落ちても、ほかのバッチと、送るほうを止めない（印は残り、次に見直す）
      console.warn("could not write a translation batch", {
        batchId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return count;
}

/** 1 つのバッチを見にいき、終わっていれば結果を書く。訳文を書いた記事の数を返す */
async function checkBatch(
  platform: MaintainPlatform,
  translator: Translator,
  batchId: string,
): Promise<number> {
  const { db } = platform;
  let status: Awaited<ReturnType<Translator["checkBatch"]>>;
  try {
    status = await translator.checkBatch(batchId);
  } catch (error) {
    console.warn("could not check a translation batch", {
      batchId,
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }
  if (status.status === "in_progress") return 0;
  if (status.status === "gone") {
    // もう見られない（結果の期限が過ぎた）。どの記事も訳せなかったものとして数える（決定の 8）
    const changed = await failBatchArticles(db, batchId, { count: true, refused: null });
    await notifyTranslationChanged(platform, changed);
    return 0;
  }
  const rows = new Map((await listBatchRows(db, batchId)).map((row) => [row.articleId, row]));
  const written: string[] = [];
  const keep: string[] = [];
  const failed: string[] = [];
  for (const result of status.results) {
    const row = rows.get(result.id);
    // 知らない記事と、重なった結果は使わない
    if (row === undefined) continue;
    rows.delete(result.id);
    if (result.status !== "translated") {
      const changed = await failBatchArticles(db, batchId, {
        articleId: result.id,
        ...batchFailure(result),
      });
      failed.push(...changed);
      continue;
    }
    try {
      const outcome = await writeBatchResult(platform, batchId, row, result);
      if (outcome === "written") written.push(result.id);
      else if (outcome === "keep") keep.push(result.id);
    } catch (error) {
      // この記事は印を残して次の定期実行で書き直し、ほかの記事は書き続ける
      keep.push(result.id);
      console.warn("could not write a translation batch result", {
        batchId,
        articleId: result.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  // 結果のなかった記事は、数えずに待ちに戻す
  await unmarkCheckedBatch(db, batchId, keep);
  await notifyTranslationChanged(platform, [...written, ...failed]);
  return written.length;
}

/**
 * バッチで訳せなかった結果の扱い（docs/decisions/translation.md の 4、8）。拒否はその回で諦める。
 * 待てば通る誤り（一時的な種類）と、モデルを外す判断に数えた要求の形の誤り（決定の 9）は数えない。
 * ほか（上限で切れた・読めない応答、ほかの誤り、expired、canceled）は数える
 */
function batchFailure(result: BatchTranslationResult): {
  count: boolean;
  refused: { category: string | null } | null;
} {
  switch (result.status) {
    case "refused":
      return { count: false, refused: { category: result.category } };
    case "errored":
      // 要求の形の誤りは、モデルを外す判断に数えたときだけ数えない（一度訳せたモデルでの誤りは、
      // 記事の中身によるものとして数える）
      if (result.errorType === "invalid_request_error") {
        return { count: !result.countedForModel, refused: null };
      }
      return {
        count: result.errorType === null || !UNCOUNTED_BATCH_ERRORS.has(result.errorType),
        refused: null,
      };
    default:
      return { count: true, refused: null };
  }
}

/** 回数に数えない、バッチの結果の一時的な誤りの種類（429、529、5xx、時間切れ。決定の 8） */
const UNCOUNTED_BATCH_ERRORS = new Set([
  "rate_limit_error",
  "overloaded_error",
  "api_error",
  "timeout_error",
]);

/**
 * バッチの 1 件の訳を書く。written は書いた、keep は容量が足りずに書けなかった（印を残して次に書き直す）、
 * requeue は書かずに待ちに戻す（記事が消えた、送ったときと分け方が違う。ほかの書き込みで訳文が入った）
 */
async function writeBatchResult(
  platform: MaintainPlatform,
  batchId: string,
  row: { contentSource: "feed" | "page" | null; bodyHash: string | null; copies: number },
  result: { id: string; segments: TranslationSegment[]; model: string },
): Promise<"written" | "keep" | "requeue"> {
  const { db } = platform;
  const article = await readArticle(platform, result.id);
  if (article === undefined) return "requeue";
  const body =
    row.contentSource === null
      ? null
      : await bodyToTranslate(platform, result.id, article.contentKey, row.contentSource);
  const copies = copiesFor(article, row.copies);
  // 分け方が送ったときと違えば（その間のデプロイ）、訳がずれるので書かずに待ちに戻し、今の分け方で
  // 送り直す
  if (body !== null && (await segmentsHash(body.segments.segments)) !== row.bodyHash) {
    console.warn("the article body was split differently from the sent batch", {
      articleId: result.id,
    });
    return "requeue";
  }
  // 送った断片の訳だけを使う。返ってこなかった断片は、原文のまま残す（決定の 10）
  const sent = new Set([
    ...segmentsOf(article, copies).map((segment) => segment.id),
    ...((copies & COPY_BODY) === 0 ? (body?.segments.segments.map((s) => s.id) ?? []) : []),
  ]);
  const translated = new Map(
    result.segments.filter((s) => sent.has(s.id)).map((s) => [s.id, s.text]),
  );
  const ok = await finishBatchTranslation(db, {
    articleId: result.id,
    batchId,
    title: article.title == null ? null : (translated.get("title") ?? article.title),
    summary: article.summary == null ? null : (translated.get("summary") ?? article.summary),
    content: body === null || (copies & COPY_BODY) !== 0 ? null : assembleBody(body, translated),
    model: result.model,
    copies,
    originalTitle: article.title,
    originalSummary: article.summary,
    bodySource: body?.source ?? null,
    bodyHash: await bodyFingerprint(body),
  });
  if (ok) return "written";
  // 行がまだそのバッチの印を持ち訳文がないなら、容量のトリガーが書かなかった。次に書き直す
  const current = await getTranslation(db, result.id);
  return current?.batchId === batchId && current.translatedAt === null ? "keep" : "requeue";
}

/**
 * 送る本文の指紋（サニタイズした HTML の SHA-256 の 16 進。本文を送らないなら "none"。決定の 16）。
 * 同じ元記事の本文を写すかを、これで決める
 */
async function bodyFingerprint(body: { html: string } | null): Promise<string> {
  return body === null ? NO_BODY_HASH : sha256Hex(body.html);
}

async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** 送る断片（写す部分を除く。決定の 16） */
function sentSegments(
  article: { title: string | null; summary: string | null },
  body: Body | null,
  copies: number,
): TranslationSegment[] {
  return [
    ...segmentsOf(article, copies),
    ...((copies & COPY_BODY) === 0 ? (body?.segments.segments ?? []) : []),
  ];
}

/** 写す部分のうち、その記事に原文のあるものだけ（原文のないタイトル・要約は写さない） */
function copiesFor(article: { title: string | null; summary: string | null }, copies: number) {
  let result = copies;
  if (!article.title?.trim()) result &= ~COPY_TITLE;
  if (!article.summary?.trim()) result &= ~COPY_SUMMARY;
  return result;
}

/** 送る断片の指紋（SHA-256 の 16 進） */
async function segmentsHash(segments: readonly TranslationSegment[]): Promise<string> {
  const data = new TextEncoder().encode(JSON.stringify(segments.map((s) => [s.id, s.text])));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
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

/** 訳す断片（タイトルと要約）。空のものと、同じ元記事から写すもの（決定の 16）は送らない */
export function segmentsOf(
  article: { title: string | null; summary: string | null },
  copies = 0,
): TranslationSegment[] {
  const segments: TranslationSegment[] = [];
  if (article.title?.trim() && (copies & COPY_TITLE) === 0) {
    segments.push({ id: "title", text: article.title });
  }
  if (article.summary?.trim() && (copies & COPY_SUMMARY) === 0) {
    segments.push({ id: "summary", text: article.summary });
  }
  return segments;
}

/**
 * その場の翻訳と訳し直しの仕事（docs/decisions/translation.md の 5、6、8）。始めた時刻が今の行と
 * 同じときだけ動く。訳し直しは Opus のモデルで訳し、書く文で訳し直しの印を付ける。
 *
 * やり直せる失敗は、行の回数を 1 つ数えてから例外を投げ、仕事の表にやり直させる。3 回目で
 * 訳せなかったものとして戻す（訳し直しなら、もとの訳文のまま translated）。拒否・上限で切れた応答・
 * 読めない応答・要求の形の誤りは、すぐに戻す
 */
export async function runTranslateArticle(
  platform: Pick<Platform, "db" | "translator" | "retentionConfig" | "syncUpdates" | "content">,
  articleId: string,
  startedAt: Date,
  options: { retranslation?: boolean } = {},
): Promise<void> {
  // やり直せる失敗で例外を投げるときは、回数しか変えていないので知らせない
  const retranslation = options.retranslation === true;
  if (!(await translateArticle(platform, articleId, startedAt, retranslation))) return;
  await notifyTranslationChanged(platform, [articleId]);
  if (!retranslation) return;
  // 訳し直した直後に、同じ元記事のほかの行に写す（決定の 16）。写せなければ（訳し直せずに戻した、
  // 写すところで落ちた）定期実行が写し直すので、仕事を失敗にしない
  try {
    await spreadRetranslations(platform, articleId);
  } catch (error) {
    console.warn("could not spread the retranslation; retrying at the next schedule", {
      articleId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** @returns 行の状態を変えたら true */
async function translateArticle(
  platform: Pick<Platform, "db" | "translator" | "retentionConfig" | "content">,
  articleId: string,
  startedAt: Date,
  retranslation: boolean,
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
  // 訳し直しで、もとの訳文に本文があれば、同じ出どころの本文を訳す。それでも本文を置けなければ、
  // 呼ばずに失敗にする（訳文を減らさない。決定の 6）
  const keepBody = retranslation && row.content !== null && row.contentSource !== null;
  const body =
    article === undefined
      ? null
      : await bodyToTranslate(
          platform,
          articleId,
          article.contentKey,
          keepBody ? (row.contentSource ?? undefined) : undefined,
        );
  if (keepBody && body === null) {
    console.warn("retranslation cannot keep the translated body", { articleId });
    return failTranslating(db, articleId, startedAt);
  }
  const bodyHash = await bodyFingerprint(body);
  // その場の翻訳は、同じ元記事から写せる部分を呼ばずに写す（決定の 16。待たない）。訳し直しは
  // 写さない（Opus で訳し直す）
  let copies =
    retranslation || article === undefined
      ? 0
      : copiesFor(article, await findCopies(db, articleId, bodyHash));
  if (copies !== 0 && article !== undefined && sentSegments(article, body, copies).length === 0) {
    const copied = await finishCopiedTranslating(db, {
      articleId,
      startedAt,
      copies,
      originalTitle: article.title,
      originalSummary: article.summary,
      bodySource: body?.source ?? null,
      bodyHash,
    });
    if (copied) return true;
    // 書けなかった（写す元がなくなった、容量が足りない、行が変わった）。行が変わっていなければ、写さず
    // にすべて送り直す（決定の 16）。容量が足りなければ、下の見積もりで呼ばずに失敗にする（決定の 12）
    const current = await getTranslation(db, articleId);
    if (current?.status !== "translating" || current.startedAt?.getTime() !== startedAt.getTime()) {
      return false;
    }
    copies = 0;
  }
  const segments =
    article === undefined
      ? [...(body?.segments.segments ?? [])]
      : sentSegments(article, body, copies);
  // 写す本文も、書くときに容量を使うので見積もりに入れる（呼んでから容量に当たって捨てないため）
  const bodyBytes = body === null ? 0 : new TextEncoder().encode(body.html).length;
  if (segments.length === 0 || !(await hasRoomForTranslation(platform, segments, bodyBytes))) {
    return failTranslating(db, articleId, startedAt);
  }

  let result: Awaited<ReturnType<typeof translator.translate>>;
  try {
    result = await translator.translate(segments, { retranslation });
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
    // 拒否なら、その拒否の種類を理由に残す（docs/decisions/translation.md の 17）
    return failTranslating(
      db,
      articleId,
      startedAt,
      result.status === "refused"
        ? { kind: "refused", category: result.category, stage: "on_demand" }
        : undefined,
    );
  }
  // 返ってこなかった断片は、原文のまま残す（docs/decisions/translation.md の 10）
  const translated = new Map(result.segments.map((s) => [s.id, s.text]));
  const content =
    body === null || (copies & COPY_BODY) !== 0 ? null : assembleBody(body, translated);
  if (keepBody && content === null) {
    // 組み立てた本文が上限を超えた。呼び直さずに失敗にする（決定の 6、8）
    console.warn("retranslation cannot keep the translated body", { articleId });
    return failTranslating(db, articleId, startedAt);
  }
  const written = await finishTranslating(db, {
    articleId,
    startedAt,
    title: article?.title == null ? null : (translated.get("title") ?? article.title),
    summary: article?.summary == null ? null : (translated.get("summary") ?? article.summary),
    content,
    model: result.model,
    retranslation,
    bodyHash,
    copies,
    originalTitle: article?.title ?? null,
    originalSummary: article?.summary ?? null,
    bodySource: body?.source ?? null,
  });
  if (written) return true;
  // 行がまだ同じなら、容量のトリガーが書かなかった。呼び直さずに戻す（決定の 12）
  return failTranslating(db, articleId, startedAt);
}
