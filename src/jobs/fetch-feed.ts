import { type ArticleInput, insertArticles } from "../db/articles";
import { clearUsedContentNotes, findExistingGuids, noteContentKeys } from "../db/content";
import { getFeed, recordFeedIcon, recordFetchFailure, recordFetchSuccess } from "../db/feeds";
import { deliverNewArticles } from "../db/inbox";
import {
  CLEAN_UP_CATCH_UP,
  deleteExpiredArticles,
  planFeedCleanUp,
  removeExpiredFromInbox,
} from "../db/retention";
import type { Feed } from "../db/schema";
import { FetchFeedError, fetchFeed } from "../fetcher/fetch-feed";
import { findFeedIcon } from "../fetcher/find-icon";
import {
  htmlToText,
  MAX_ITEMS,
  type ParsedItem,
  ParseFeedError,
  parseFeed,
} from "../fetcher/parse-feed";
import { hasMarkupBeyondText, sanitizeHtml } from "../lib/sanitize-html";
import type { Platform } from "../platform";

/*
 * 取得の間隔は設定（platform.fetchConfig）から受け取る。いまはすべてのフィードで同じ。
 * フィードごとの調整は後で足す（docs/decisions/jobs.md の「見直す条件」）。
 */

/** フィードのアイコンを探し直す間隔（docs/decisions/images.md の 8） */
export const ICON_CHECK_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000;

/** 1 回の取得で本文を置く、新しい記事の数の上限（docs/decisions/content.md の 4） */
export const MAX_CONTENTS_PER_FETCH = 30;

/** 置く本文の大きさの上限（サニタイズしたあとの UTF-8 のバイト数）。超えたら、本文なしで取り込む */
export const MAX_CONTENT_BYTES = 256 * 1024;

/** 失敗が続いたときに延ばす間隔の上限。設定の間隔がこれより長ければ、設定の間隔 */
const MAX_BACKOFF_MS = 24 * 60 * 60 * 1000;

export type FetchFeedOutcome =
  | { status: "fetched"; inserted: number }
  | { status: "not-modified" }
  | { status: "failed"; error: string }
  | { status: "missing" };

/**
 * フィードを1つ取得して、新しい記事を保存する。あわせて、古い記事を片付ける
 * （docs/decisions/retention.md の 4）。
 *
 * フィードの側の問題（取得できない、形式が壊れている）は、フィードに記録して
 * 間隔を延ばし、正常に終わらせる。キューのやり直しに回すのは、DB の失敗など
 * こちら側の予期しない例外だけにする。
 */
export async function runFetchFeed(
  platform: Pick<Platform, "db" | "content" | "fetch" | "now" | "fetchConfig" | "retentionConfig">,
  feedId: string,
): Promise<FetchFeedOutcome> {
  const { db } = platform;
  const { intervalMs } = platform.fetchConfig;
  const feed = await getFeed(db, feedId);
  if (!feed) return { status: "missing" };

  const startedAt = platform.now();

  // 期間を過ぎた記事を、受信箱から片付ける。取得の結果によらない。片付けた位置は、取得の結果と
  // 一緒に記録する（記録の前に落ちても、やり直せば同じ範囲をもう一度片付けるだけ）
  const cleanUp = planFeedCleanUp(feed, {
    now: startedAt,
    retentionMs: platform.retentionConfig.articleMs,
    stepMs: CLEAN_UP_CATCH_UP * intervalMs,
  });
  if (cleanUp) await removeExpiredFromInbox(db, { feedId: feed.id, window: cleanUp });
  const cleanedUntil = cleanUp?.until ?? feed.cleanedUntil;

  try {
    const result = await fetchFeed(feed.url, {
      fetch: platform.fetch,
      etag: feed.etag,
      lastModified: feed.lastModified,
    });

    if (result.status === "not-modified") {
      // 前回の取得が、受信箱に配る途中で落ちていた場合に備えて、配り直しを試みる
      await deliverNewArticles(db, { feedId: feed.id });
      await recordFetchSuccess(db, feed.id, {
        now: startedAt,
        nextFetchAt: new Date(startedAt.getTime() + intervalMs),
        etag: feed.etag,
        lastModified: feed.lastModified,
        cleanedUntil: cleanUp?.until,
      });
      // フィードの中身は読んでいないので、フィード自身のアイコンは分からない。サイトから探す
      await refreshIcon(platform, feed, { siteUrl: feed.siteUrl, feedIconUrl: null }, startedAt);
      return { status: "not-modified" };
    }

    const parsed = parseFeed(result.body, result.url);
    const rows = await Promise.all(parsed.items.map((item) => toArticle(feed.id, item, startedAt)));
    // 新しい記事の本文を、記事の行を入れる前に置く（docs/decisions/content.md の 4）
    const contentKeys = await storeContents(platform, {
      feedId: feed.id,
      feedUrl: result.url,
      items: parsed.items,
      rows,
    });
    const inserted = await insertArticles(db, rows);
    // 行に入った名前の書き留めを消す。入らなかった名前は残り、1 日 1 回の片付けが本文を消す
    await clearUsedContentNotes(db, contentKeys);
    // 購読している人の受信箱に配る。記事を入れ終えてから配り、配り終えてから取得済みとして記録する
    await deliverNewArticles(db, { feedId: feed.id });

    // 片付けた範囲までの記事のうち、どの受信箱にも残っておらず、フィードにもう載っていないものを
    // 消す。フィードに載っている記事を消すと、次の取得で新しい記事として入り直すため。
    // 解析は MAX_ITEMS 件で打ち切るので、そこまで届いたら、後ろにまだ載っているかもしれない。
    // そのときは記事の行を消さない（受信箱からは消える。行は、件数が減ったときに消える）
    if (cleanedUntil && parsed.items.length < MAX_ITEMS) {
      await deleteExpiredArticles(db, {
        feedId: feed.id,
        until: cleanedUntil,
        currentGuids: rows.map((row) => row.guid),
      });
    }

    // 記事を入れ終えてから、取得済みとして記録する。途中で落ちても、次の取得でやり直せる
    await recordFetchSuccess(db, feed.id, {
      now: startedAt,
      nextFetchAt: new Date(startedAt.getTime() + intervalMs),
      etag: result.etag,
      lastModified: result.lastModified,
      title: parsed.title,
      siteUrl: parsed.siteUrl,
      cleanedUntil: cleanUp?.until,
    });
    // フィードの名前やサイトの URL が変わると、購読の変更番号はトリガーが進める
    // （migrations/0003_received_seq_and_feed_trigger.sql。同期でクライアントに伝わる）
    await refreshIcon(
      platform,
      feed,
      { siteUrl: parsed.siteUrl, feedIconUrl: parsed.iconUrl },
      startedAt,
    );
    return { status: "fetched", inserted };
  } catch (error) {
    if (!(error instanceof FetchFeedError || error instanceof ParseFeedError)) throw error;

    const errorCount = feed.errorCount + 1;
    // 上限は、設定の間隔より短くしない（1 日より長い間隔にしたとき、失敗中のフィードのほうが
    // 頻繁に取得されないように）
    const backoff = Math.min(intervalMs * 2 ** errorCount, Math.max(MAX_BACKOFF_MS, intervalMs));
    const message = `${error.name}: ${error.message}`;
    await recordFetchFailure(db, feed.id, {
      now: startedAt,
      nextFetchAt: new Date(startedAt.getTime() + backoff),
      errorCount,
      error: message,
      cleanedUntil: cleanUp?.until,
    });
    return { status: "failed", error: message };
  }
}

/**
 * フィードのアイコンを、30 日に 1 回探して記録する（docs/decisions/images.md の 8）。
 *
 * 取得の結果を記録したあとに呼ぶ。探すのに失敗しても（取得できない、時間切れなど）、フィードの
 * 取得は失敗にしない。記録の前に落ちたら、次の取得でもう一度探す
 */
async function refreshIcon(
  platform: Pick<Platform, "db" | "fetch">,
  feed: Feed,
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
 * @returns 置いた本文の名前
 */
async function storeContents(
  platform: Pick<Platform, "db" | "content">,
  input: { feedId: string; feedUrl: string; items: ParsedItem[]; rows: ArticleInput[] },
): Promise<string[]> {
  const { db } = platform;
  const withContent = input.rows.flatMap((row, index) => {
    const html = input.items[index]?.contentHtml;
    return html ? [{ row, html }] : [];
  });
  if (withContent.length === 0) return [];

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
  if (contents.length === 0) return [];

  const keys = contents.map(({ key }) => key);
  await noteContentKeys(db, keys);
  await Promise.all(contents.map(({ key, html }) => platform.content.put(key, html)));
  for (const { row, key } of contents) row.contentKey = key;
  return keys;
}

/** 本文の置き場の名前。置くたびに乱数で決める */
function newContentKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `feed/${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
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
  };
}

/** ID も URL もない記事は、中身のハッシュで見分ける */
async function contentHash(item: ParsedItem): Promise<string> {
  const source = JSON.stringify([item.title, item.summary, item.publishedAt?.toISOString()]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `sha256:${hex}`;
}
