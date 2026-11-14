import { findFeedByUrl, insertFeed } from "../db/feeds";
import { backfillInbox } from "../db/inbox";
import type { Feed } from "../db/schema";
import { getSubscription, type SubscriptionWithFeed, subscribeMany } from "../db/subscriptions";
import { discoverFeed } from "../fetcher/discover";
import { toFetchableUrl } from "../fetcher/url-guard";
import type { Platform } from "../platform";

/*
 * URL から購読する手続き。REST API、Google Reader API、MCP で同じものを使う
 * （docs/decisions/greader.md の 5。同じ処理を 2 か所に書かない）。
 */

/**
 * フィード（共有）をユーザーが購読する。新しく購読したら、すでに取り込んである最近の記事を
 * 受信箱に入れ、しばらく取得していないフィードなら取得を積む。
 */
export async function subscribeFeed(
  platform: Platform,
  input: { userId: string; feed: Feed; feedCreated: boolean; folderId: string | null },
): Promise<{ subscription: SubscriptionWithFeed; created: boolean }> {
  const { db } = platform;
  const now = platform.now();
  const created =
    (
      await subscribeMany(db, {
        userId: input.userId,
        rows: [{ feedId: input.feed.id, folderId: input.folderId }],
        now,
      })
    ).length > 0;
  // 新しく購読したときだけでなく、前回の補充が途中で落ちていた場合も、ここで入れ直す
  await backfillInbox(db, { userId: input.userId, feedIds: [input.feed.id], now });
  if (input.feedCreated || (created && input.feed.nextFetchAt <= now)) {
    await platform.jobs.enqueue([{ type: "fetch-feed", feedId: input.feed.id }]);
  }
  const subscription = await getSubscription(db, { userId: input.userId, feedId: input.feed.id });
  if (!subscription) throw new Error(`subscription disappeared: ${input.feed.id}`);
  return { subscription, created };
}

/**
 * フィードかサイトの URL から購読する。フィード（共有）がすでにあれば取得せずに購読し、なければ
 * URL を取得してフィードを見つける。
 * @throws UrlNotAllowedError 取得してはいけない URL（fetcher/url-guard.ts）
 * @throws DiscoverError フィードが見つからない（fetcher/discover.ts）
 */
export async function subscribeToUrl(
  platform: Platform,
  input: { userId: string; url: string; folderId: string | null },
): Promise<{ subscription: SubscriptionWithFeed; created: boolean }> {
  const { db } = platform;
  const url = toFetchableUrl(input.url);

  const existing = await findFeedByUrl(db, url.href);
  if (existing) {
    return subscribeFeed(platform, { ...input, feed: existing, feedCreated: false });
  }

  const discovered = await discoverFeed(url, { fetch: platform.fetch });
  const { feed, created: feedCreated } = await insertFeed(db, {
    id: crypto.randomUUID(),
    url: discovered.url,
    // 確かめるときに読んだタイトルを先に入れておく。取得のジョブが終わるまで、名前のない
    // フィードが一覧に並ばないように
    title: discovered.title,
    now: platform.now(),
  });
  return subscribeFeed(platform, { ...input, feed, feedCreated });
}
