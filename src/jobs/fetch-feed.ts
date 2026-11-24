import {
  type ArticleInput,
  estimateArticleBytes,
  insertArticles,
  recordCurrentFeed,
} from "../db/articles";
import {
  clearUsedContentNotes,
  findExistingGuids,
  MAX_CONTENT_BYTES,
  noteContentKeys,
  reserveContents,
} from "../db/content";
import { getFeed, recordFeedIcon, recordFetchFailure, recordFetchSuccess } from "../db/feeds";
import { deliverNewArticles } from "../db/inbox";
import type { Feed, FeedErrorCode } from "../db/schema";
import { isStorageLimitError, readStorageUsage } from "../db/storage";
import { findFeedRelocation, MAX_FEED_LINK_PAGE_BYTES } from "../fetcher/discover";
import { type FetchedFeedPage, FetchFeedError, fetchFeed } from "../fetcher/fetch-feed";
import { findFeedIcon, ICON_CHECK_INTERVAL_MS } from "../fetcher/find-icon";
import { htmlToText, type ParsedItem, ParseFeedError, parseFeed } from "../fetcher/parse-feed";
import { hasMarkupBeyondText, sanitizeHtml } from "../lib/sanitize-html";
import type { Platform } from "../platform";
import { enqueueArticleLanguages } from "./article-languages";
import { runFetchDiscord } from "./fetch-discord";
import {
  backoffInterval,
  currentFetchInterval,
  FETCH_FAILURE_WINDOW_MS,
  retryAfterWait,
  STALLED_FETCH_INTERVAL_MS,
} from "./fetch-interval";
import { nextFetchInterval } from "./fetch-slots";
import { canStoreArticles, measureExistingContents, reportStorageFull } from "./storage";

/*
 * 取得の間隔は、フィードごとに記事の出るペースから決める。設定の間隔（platform.fetchConfig）は、
 * その下限（docs/decisions/jobs.md の 6、7。決め方は fetch-interval.ts）。
 */

export { ICON_CHECK_INTERVAL_MS };

/** 1 回の取得で本文を置く、新しい記事の数の上限（docs/decisions/content.md の 4） */
export const MAX_CONTENTS_PER_FETCH = 30;

/** 置く本文の大きさの上限。ページから抜いた本文と同じ（db/content.ts） */
export { MAX_CONTENT_BYTES } from "../db/content";

export type FetchFeedOutcome =
  | { status: "fetched"; inserted: number }
  | { status: "not-modified" }
  | { status: "failed"; error: string }
  | { status: "deferred" }
  | { status: "missing" }
  | { status: "storage-full" };

/**
 * フィードを1つ取得して、新しい記事を保存する。あわせて、古い記事を片付ける
 * （docs/decisions/retention.md の 4）。
 *
 * フィードの側の問題（取得できない、形式が壊れている）は、フィードに記録して
 * 間隔を延ばし、正常に終わらせる。キューのやり直しに回すのは、DB の失敗など
 * こちら側の予期しない例外だけにする。
 */
export async function runFetchFeed(
  platform: Pick<
    Platform,
    | "db"
    | "content"
    | "fetch"
    | "now"
    | "fetchConfig"
    | "retentionConfig"
    | "jobs"
    | "discord"
    | "syncUpdates"
  >,
  feedId: string,
  jobType?: "fetch-feed" | "fetch-discord",
): Promise<FetchFeedOutcome> {
  const { db } = platform;
  const minIntervalMs = platform.fetchConfig.intervalMs;
  const feed = await getFeed(db, feedId);
  if (!feed || (feed.discordCursor !== null && feed.discordConnectionId === null))
    return { status: "missing" };
  if (jobType === "fetch-discord" && feed.discordCursor === null) return { status: "missing" };
  // 更新前にキューへ積まれた Discord の取得も、今の直列化を通す。
  if (jobType === "fetch-feed" && feed.discordCursor !== null) {
    await platform.jobs.enqueue([{ type: "fetch-discord", feedId }]);
    return { status: "deferred" };
  }

  const startedAt = platform.now();
  await measureExistingContents(platform);
  const canStore = await canStoreArticles(platform);

  let fetchedPage: FetchedFeedPage | undefined;
  try {
    if (feed.discordCursor !== null)
      return await runFetchDiscord(platform, feed, startedAt, canStore);

    const result = await fetchFeed(feed.url, {
      fetch: platform.fetch,
      etag: feed.etag,
      lastModified: feed.lastModified,
      now: startedAt,
      notFoundPageBytes: MAX_FEED_LINK_PAGE_BYTES,
    });

    if (result.status === "not-modified") {
      // 前回の取得が、受信箱に配る途中で落ちていた場合に備えて、配り直しを試みる
      await deliverNewArticles(db, { feedId: feed.id }, platform.syncUpdates.notify);
      // 新しい記事がなくても、時間がたった分だけペースは落ちているので、間隔を決め直す
      const nextIntervalMs = await nextFetchInterval(db, {
        feedId: feed.id,
        now: startedAt,
        minMs: minIntervalMs,
        feedCreatedAt: feed.createdAt,
      });
      const recorded = await recordFetchSuccess(db, feed.id, {
        now: startedAt,
        nextFetchAt: new Date(startedAt.getTime() + nextIntervalMs),
        fetchIntervalMs: nextIntervalMs,
      });
      if (recorded) {
        // フィードの中身は読んでいないので、サイトからアイコンを探す
        await refreshIcon(
          platform,
          recorded,
          { siteUrl: recorded.siteUrl, feedIconUrl: null },
          startedAt,
        );
      }
      return { status: "not-modified" };
    }

    fetchedPage = result;
    const parsed = parseFeed(result.body, result.url);
    const rows = await Promise.all(parsed.items.map((item) => toArticle(feed.id, item, startedAt)));
    await recordCurrentFeed(
      db,
      feed.id,
      rows.map((row) => row.guid),
      parsed.items.length,
    );
    if (!canStore) {
      // 前回の取り込みが配布の前で落ちていても、確保済みの受信箱の容量で配り切れる。
      await deliverNewArticles(db, { feedId: feed.id }, platform.syncUpdates.notify);
      await platform.jobs.enqueue([{ type: "clean-up" }]);
      return { status: "storage-full" };
    }
    // 新しい記事の本文を、記事の行を入れる前に置く（docs/decisions/content.md の 4）
    const storedContents = await storeContents(platform, {
      feedId: feed.id,
      feedUrl: result.url,
      items: parsed.items,
      rows,
    });
    const insertedArticles = await insertArticles(
      db,
      rows.filter((row) => !storedContents.deferredIds.has(row.id)),
    );
    // 行に入った名前の書き留めを消す。入らなかった名前は残り、1 日 1 回の片付けが本文を消す
    await clearUsedContentNotes(db, storedContents.keys);
    // 購読している人の受信箱に配る。記事を入れ終えてから配り、配り終えてから取得済みとして記録する
    await deliverNewArticles(db, { feedId: feed.id }, platform.syncUpdates.notify);
    // 新しい記事ごとに、ページから本文を抜く仕事を積む（docs/decisions/content.md の 10）。ここで落ちて積めなくても、読者が開いたときに抜く
    await enqueuePageContents(platform, insertedArticles);
    // 新しい記事の言語の判定も積む（docs/decisions/jobs.md の 13）。積めなければ定期実行が拾う
    await enqueueArticleLanguages(
      platform,
      insertedArticles.map((article) => article.id),
    );

    // フィードに今載っているかは、解析できたときだけ記録する。打ち切った場合は、
    // 見えなかった記事を「外れた」と扱わない（MAX_ITEMS 件での打ち切りも含む）。
    const existing =
      insertedArticles.length === rows.length
        ? null
        : await findExistingGuids(db, {
            feedId: feed.id,
            guids: rows.map((row) => row.guid),
          });
    const usage = await readStorageUsage(db);
    if (existing !== null && existing.size < new Set(rows.map((row) => row.guid)).size) {
      reportStorageFull(platform, usage);
      await platform.jobs.enqueue([{ type: "clean-up" }]);
      return { status: "storage-full" };
    }
    if (usage.bytes >= platform.retentionConfig.maxBytes * 0.9) {
      await platform.jobs.enqueue([{ type: "clean-up" }]);
    }

    // 今回入った記事も含めて、間隔を決め直す
    const nextIntervalMs = await nextFetchInterval(db, {
      feedId: feed.id,
      now: startedAt,
      minMs: minIntervalMs,
      feedCreatedAt: feed.createdAt,
    });
    // 記事を入れ終えてから、取得済みとして記録する。途中で落ちても、次の取得でやり直せる
    const recorded = await recordFetchSuccess(db, feed.id, {
      now: startedAt,
      nextFetchAt: new Date(startedAt.getTime() + nextIntervalMs),
      fetchIntervalMs: nextIntervalMs,
      etag: result.etag,
      lastModified: result.lastModified,
      title: parsed.title,
      siteUrl: parsed.siteUrl,
    });
    // フィードの名前やサイトの URL が変わると、購読の変更番号はトリガーが進める
    // （migrations/0003_received_seq_and_feed_trigger.sql。同期でクライアントに伝わる）
    if (recorded) {
      await refreshIcon(
        platform,
        recorded,
        { siteUrl: parsed.siteUrl, feedIconUrl: parsed.iconUrl },
        startedAt,
      );
    }
    return { status: "fetched", inserted: insertedArticles.length };
  } catch (error) {
    if (isStorageLimitError(error)) {
      reportStorageFull(platform);
      await platform.jobs.enqueue([{ type: "clean-up" }]);
      return { status: "storage-full" };
    }
    if (!(error instanceof FetchFeedError || error instanceof ParseFeedError)) throw error;

    const errorCode = error instanceof FetchFeedError ? error.code : "invalid_feed";
    // Retry-After は、応答を受けた時刻から数える（docs/decisions/jobs.md の 8）
    const retryAfter =
      error instanceof FetchFeedError ? retryAfterWait(error.retryAfterMs, minIntervalMs) : 0;
    const failedAt = platform.now().getTime();
    const retryAt = failedAt + retryAfter;
    const discordRetryAt =
      feed.discordCursor !== null &&
      error instanceof FetchFeedError &&
      error.status === 429 &&
      error.retryAfterMs !== undefined
        ? new Date(failedAt + Math.max(1000, error.retryAfterMs))
        : undefined;
    const message = `${error.name}: ${error.message}`;
    const page = error instanceof FetchFeedError ? error.notFoundPage : fetchedPage;
    const relocationCandidate = page
      ? await findFeedRelocation(page, feed.url, platform.fetch)
      : undefined;
    const retryDiscord = await recordFailedAttempt(db, feed, {
      startedAt,
      minIntervalMs,
      retryAt,
      discordRetryAt:
        discordRetryAt && Number.isFinite(discordRetryAt.getTime()) ? discordRetryAt : null,
      message,
      errorCode,
      relocationCandidate,
    });
    if (retryDiscord) await platform.jobs.enqueue([{ type: "fetch-discord", feedId: feed.id }]);
    return { status: "failed", error: message };
  }
}

async function recordFailedAttempt(
  db: Platform["db"],
  feed: Feed,
  input: {
    startedAt: Date;
    minIntervalMs: number;
    retryAt: number;
    discordRetryAt: Date | null;
    message: string;
    errorCode: FeedErrorCode;
    relocationCandidate: Feed["relocationCandidate"] | undefined;
  },
): Promise<boolean> {
  const { startedAt, minIntervalMs, retryAt, message, errorCode, relocationCandidate } = input;
  const rateLimited = errorCode === "rate_limited";
  const discord = feed.discordCursor !== null;
  let latest: Feed | undefined = feed;
  for (
    let retries = 0;
    latest &&
    latest.discordConnectionId === feed.discordConnectionId &&
    (discord || latest.lastFetchedAt === null || latest.lastFetchedAt < startedAt);
    retries++
  ) {
    // 先行した取得が書き込んだ場合は、その結果から間隔と状態を計算し直す。
    // 競合が続く場合は、数回で諦めてキューの再試行に任せる。
    if (retries > 3) throw new Error(`could not record fetch result for ${feed.id}`);
    const intervalMs = currentFetchInterval(latest, minIntervalMs);
    const errorCount = rateLimited ? latest.errorCount : latest.errorCount + 1;
    const failureStartedAt = rateLimited
      ? latest.failureStartedAt
      : (latest.failureStartedAt ?? startedAt);
    const fetchStalled =
      latest.fetchStalled ||
      errorCode === "gone" ||
      (!rateLimited &&
        failureStartedAt !== null &&
        startedAt.getTime() - failureStartedAt.getTime() >= FETCH_FAILURE_WINDOW_MS);
    const backoff = fetchStalled
      ? Math.max(STALLED_FETCH_INTERVAL_MS, minIntervalMs)
      : backoffInterval({ intervalMs, errorCount: Math.max(errorCount, 1), minMs: minIntervalMs });
    const discordRetryAt = fetchStalled ? null : input.discordRetryAt;
    const recorded = await recordFetchFailure(db, latest, {
      now: startedAt,
      nextFetchAt: discordRetryAt
        ? latest.nextFetchAt
        : new Date(Math.max(startedAt.getTime() + backoff, retryAt)),
      discordRetryAt,
      errorCount,
      error: message,
      errorCode,
      failureStartedAt,
      fetchStalled,
      relocationCandidate,
    });
    // Discord の失敗は、取得を始めたときのカーソルと記録が変わっていない場合だけ残す。
    if (recorded || discord) return recorded && discordRetryAt !== null;
    latest = await getFeed(db, feed.id);
  }
  return false;
}

/**
 * フィードのアイコンを、30 日に 1 回探して記録する（docs/decisions/images.md の 8）。
 *
 * 取得の結果を記録したあとに呼ぶ。探すのに失敗しても（取得できない、時間切れなど）、フィードの
 * 取得は失敗にしない。記録の前に落ちたら、次の取得でもう一度探す
 */
async function refreshIcon(
  platform: Pick<Platform, "db" | "fetch">,
  feed: Pick<Feed, "id" | "iconUrl" | "iconCheckedAt">,
  found: { siteUrl: string | null; feedIconUrl: string | null },
  now: Date,
): Promise<void> {
  const checkedAt = feed.iconCheckedAt?.getTime();
  if (checkedAt !== undefined && now.getTime() - checkedAt < ICON_CHECK_INTERVAL_MS) return;

  let iconUrl: string | null;
  try {
    iconUrl = await findFeedIcon({
      fetch: platform.fetch,
      feedIconUrl: found.feedIconUrl,
      siteUrl: found.siteUrl,
      currentIconUrl: feed.iconUrl,
    });
  } catch (error) {
    // 外から来た中身の扱いで起きた例外。アイコンは今のままにして、次の時期にもう一度探す
    console.warn("failed to look for the feed icon", { feedId: feed.id, error });
    iconUrl = feed.iconUrl;
  }
  await recordFeedIcon(platform.db, feed.id, { iconUrl, now });
}

/**
 * 新しい記事の、フィードに入っていた本文をサニタイズして置き場に置き、置いた名前を rows に入れる
 * （docs/decisions/content.md の 1、2、4）。
 *
 * - 要約と同じ中身の本文（文字が要約と同じで、画像・リンク・コード・表などを含まない）は
 *   置かない。サニタイズしたあとで MAX_CONTENT_BYTES を超える本文も置かない
 * - 置く前に名前を書き留める。名前は乱数で、二度使わない。落ちてやり直すと、新しい名前で置き直し、
 *   前の本文は、書き留めから片付けられる
 * - すでにある記事かどうかは、置く手間を省くために読むだけ。読んだあとで別の取得が同じ記事を
 *   入れても、こちらの行が入らず、置いた本文が片付けられるだけ
 *
 * @returns 置いた本文の名前と、容量不足で記事ごと再試行する ID
 */
async function storeContents(
  platform: Pick<Platform, "db" | "content">,
  input: { feedId: string; feedUrl: string; items: ParsedItem[]; rows: ArticleInput[] },
): Promise<{ keys: string[]; deferredIds: Set<string> }> {
  const { db } = platform;
  const withContent = input.rows.flatMap((row, index) => {
    const html = input.items[index]?.contentHtml;
    return html ? [{ row, html }] : [];
  });
  if (withContent.length === 0) return { keys: [], deferredIds: new Set() };

  const existing = await findExistingGuids(db, {
    feedId: input.feedId,
    guids: withContent.map(({ row }) => row.guid),
  });
  const encoder = new TextEncoder();
  const contents: { row: ArticleInput; key: string; html: string }[] = [];
  // サニタイズは CPU を使うので、見るのも上限の数までにする
  for (const { row, html } of withContent
    .filter(({ row }) => !existing.has(row.guid))
    .slice(0, MAX_CONTENTS_PER_FETCH)) {
    const sanitized = sanitizeHtml(html, row.url ?? input.feedUrl);
    // 要約と同じ中身なら置かない。保存する要約そのものと比べる。要約は別の欄（RSS の description
    // など）から採ることがあるので、短い本文でも、要約と違えば置く。要約に収まらなかった本文は、
    // 要約が切り詰められているので、同じにならない
    const text = htmlToText(sanitized, Number.POSITIVE_INFINITY) ?? "";
    if (text === (row.summary ?? "") && !hasMarkupBeyondText(sanitized)) continue;
    if (encoder.encode(sanitized).length > MAX_CONTENT_BYTES) continue;
    contents.push({ row, key: newContentKey(), html: sanitized });
  }
  if (contents.length === 0) return { keys: [], deferredIds: new Set() };

  const keys = contents.map(({ key }) => key);
  await noteContentKeys(db, keys);
  const reserved = await reserveContents(
    db,
    contents.map(({ key, html, row }) => ({
      key,
      bytes: encoder.encode(html).length,
      articleBytes: estimateArticleBytes({ ...row, contentKey: key }),
      feedId: row.feedId,
    })),
  );
  const stored = contents.filter(({ key }) => reserved.has(key));
  await Promise.all(stored.map(({ key, html }) => platform.content.put(key, html)));
  for (const { row, key } of stored) row.contentKey = key;
  return {
    keys: stored.map(({ key }) => key),
    deferredIds: new Set(contents.filter(({ key }) => !reserved.has(key)).map(({ row }) => row.id)),
  };
}

/** 本文の置き場の名前。置くたびに乱数で決める */
function newContentKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `feed/${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** 新しく入った記事のうち、URL のあるものに、ページから本文を抜く仕事を積む */
async function enqueuePageContents(
  platform: Pick<Platform, "jobs">,
  inserted: readonly { id: string; url: string | null }[],
): Promise<void> {
  const jobs = inserted
    .filter((article) => article.url !== null)
    .map((article) => ({ type: "extract-page" as const, articleId: article.id }));
  if (jobs.length > 0) await platform.jobs.enqueue(jobs);
}

/**
 * 取り込む記事にする。createdAt は入れず、INSERT するときに DB の時計で決める
 * （取得を始めた時刻を入れると、取得中に開いた一覧の「まとめて既読」で、一覧に
 * 出ていなかった記事まで既読になる）。
 */
async function toArticle(feedId: string, item: ParsedItem, fetchedAt: Date): Promise<ArticleInput> {
  return {
    id: crypto.randomUUID(),
    feedId,
    guid: item.id ?? item.url ?? (await contentHash(item)),
    url: item.url,
    title: item.title,
    summary: item.summary,
    author: item.author,
    thumbnailUrl: item.thumbnailUrl,
    publishedAt: item.publishedAt ?? fetchedAt,
    // 日付がなく取り込んだ時刻を入れたものは、時刻が分からないものとして扱う
    publishedTimeKnown: item.publishedAt !== null && item.publishedTimeKnown,
  };
}

/** ID も URL もない記事は、中身のハッシュで見分ける */
async function contentHash(item: ParsedItem): Promise<string> {
  const source = JSON.stringify([item.title, item.summary, item.publishedAt?.toISOString()]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `sha256:${hex}`;
}
