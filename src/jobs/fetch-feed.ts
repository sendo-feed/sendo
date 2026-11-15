import { type ArticleInput, insertArticles } from "../db/articles";
import { getFeed, recordFetchFailure, recordFetchSuccess } from "../db/feeds";
import { deliverNewArticles } from "../db/inbox";
import {
  CLEAN_UP_CATCH_UP,
  deleteExpiredArticles,
  planFeedCleanUp,
  removeExpiredFromInbox,
} from "../db/retention";
import { FetchFeedError, fetchFeed } from "../fetcher/fetch-feed";
import { MAX_ITEMS, type ParsedItem, ParseFeedError, parseFeed } from "../fetcher/parse-feed";
import type { Platform } from "../platform";

/*
 * 取得の間隔は設定（platform.fetchConfig）から受け取る。いまはすべてのフィードで同じ。
 * フィードごとの調整は後で足す（docs/decisions/jobs.md の「見直す条件」）。
 */

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
  platform: Pick<Platform, "db" | "fetch" | "now" | "fetchConfig" | "retentionConfig">,
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
      return { status: "not-modified" };
    }

    const parsed = parseFeed(result.body, result.url);
    const rows = await Promise.all(parsed.items.map((item) => toArticle(feed.id, item, startedAt)));
    const inserted = await insertArticles(db, rows);
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
