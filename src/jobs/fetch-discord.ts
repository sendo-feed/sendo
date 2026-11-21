import { findExistingGuids } from "../db/content";
import {
  type DiscordArticle,
  detachDiscordFeed,
  getDiscordSubscriber,
  insertDiscordArticles,
} from "../db/discord";
import { recordFetchSuccess } from "../db/feeds";
import { deliverNewArticles } from "../db/inbox";
import type { Feed } from "../db/schema";
import { readStorageUsage } from "../db/storage";
import {
  DISCORD_CURSOR_START,
  DISCORD_INITIAL_MESSAGES,
  DISCORD_PAGE_SIZE,
  discordCursorBefore,
  getDiscordMessages,
  getReadableChannel,
  isDiscordAccessDenied,
  parseDiscordChannelUrl,
} from "../discord/client";
import { FetchFeedError } from "../fetcher/fetch-feed";
import type { Platform } from "../platform";
import type { FetchFeedOutcome } from "./fetch-feed";
import { nextFetchInterval } from "./fetch-slots";
import { reportStorageFull } from "./storage";

export async function runFetchDiscord(
  platform: Pick<
    Platform,
    "db" | "fetch" | "discord" | "fetchConfig" | "retentionConfig" | "jobs" | "syncUpdates"
  >,
  feed: Feed,
  startedAt: Date,
  canStore: boolean,
): Promise<FetchFeedOutcome> {
  const { db, discord } = platform;
  const { discordConnectionId, discordCursor } = feed;
  if (discordConnectionId === null || discordCursor === null) return { status: "missing" };
  const address = parseDiscordChannelUrl(feed.url);
  const subscriber = await getDiscordSubscriber(db, feed);
  if (!address || !subscriber) return { status: "missing" };
  if (!discord) throw new FetchFeedError("network", "Discord is not configured");

  const channel = await getReadableChannel(
    platform.fetch,
    discord,
    address,
    subscriber.discordUserId,
  );
  if (!channel) {
    await detachDiscordFeed(db, feed.id, discordConnectionId);
    return { status: "missing" };
  }

  const messages = await getDiscordMessages(
    platform.fetch,
    discord,
    address.channelId,
    discordCursor,
  ).catch((error: unknown) => {
    if (isDiscordAccessDenied(error)) return null;
    throw error;
  });
  if (!messages) {
    await detachDiscordFeed(db, feed.id, discordConnectionId);
    return { status: "missing" };
  }

  let cursor = discordCursor;
  const articles: DiscordArticle[] = [];
  for (const message of messages) {
    if (BigInt(message.id) > BigInt(cursor)) cursor = message.id;
    // 通常の投稿と返信に絞る。システムメッセージには受信箱の行を作らない。
    if (message.type !== 0 && message.type !== 19) continue;
    const summary = message.content.trim();
    if (!summary && message.attachments.length === 0 && message.embeds.length === 0) continue;
    articles.push({
      guid: message.id,
      url: `${feed.url}/${message.id}`,
      title: summary.split(/\r?\n/, 1)[0]?.slice(0, 120) || "Discord の投稿",
      summary: summary || null,
      author: message.author.global_name || message.author.username,
      publishedAt: Date.parse(message.timestamp),
    });
  }

  // 1 回目の取得は直近の投稿だけを取るので、購読より後の投稿が残っているかもしれない場合
  // （取った全部が購読より後）と、投稿が 1 件もない場合は、取得位置を購読の時刻に置く。
  // 1 回目が遅れたり、やり直したりしても、購読より後の投稿は次の取得からたどれる。
  const first = discordCursor === DISCORD_CURSOR_START;
  const subscribedAt = discordCursorBefore(feed.createdAt);
  const mayHaveOlder =
    first &&
    messages.length === DISCORD_INITIAL_MESSAGES &&
    messages.every((message) => BigInt(message.id) > BigInt(subscribedAt));
  if (mayHaveOlder || (first && messages.length === 0)) cursor = subscribedAt;

  const inserted = canStore
    ? await insertDiscordArticles(db, feed.id, discordConnectionId, articles)
    : 0;
  // 記事を入れ終えてから配り、配り終えてから次に取得する位置を記録する。
  await deliverNewArticles(db, { feedId: feed.id }, platform.syncUpdates.notify);
  const usage = await readStorageUsage(db);
  if (inserted !== articles.length) {
    // 容量のトリガーで一部だけ入らなかった場合は、次回も同じ範囲を取り直す。
    const guids = [...new Set(articles.map((article) => article.guid))];
    const existing = await findExistingGuids(db, { feedId: feed.id, guids });
    if (existing.size < guids.length) {
      if (!(await getDiscordSubscriber(db, feed))) return { status: "missing" };
      if (canStore) reportStorageFull(platform, usage);
      await platform.jobs.enqueue([{ type: "clean-up" }]);
      return { status: "storage-full" };
    }
  }
  if (usage.bytes >= platform.retentionConfig.maxBytes * 0.9) {
    await platform.jobs.enqueue([{ type: "clean-up" }]);
  }

  const minMs = platform.fetchConfig.intervalMs;
  const interval =
    mayHaveOlder || (!first && messages.length === DISCORD_PAGE_SIZE)
      ? minMs
      : await nextFetchInterval(db, {
          feedId: feed.id,
          now: startedAt,
          minMs,
          feedCreatedAt: feed.createdAt,
        });
  await recordFetchSuccess(db, feed.id, {
    now: startedAt,
    nextFetchAt: new Date(startedAt.getTime() + interval),
    fetchIntervalMs: interval,
    etag: null,
    lastModified: null,
    title: channel.name,
    // アイコンが変わると、購読の変更番号はトリガーが進める（docs/decisions/images.md の 8）
    iconUrl: channel.iconUrl,
    discord: { cursor, connectionId: discordConnectionId },
  });
  return messages.length === 0 ? { status: "not-modified" } : { status: "fetched", inserted };
}
