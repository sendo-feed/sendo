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
  DISCORD_PAGE_SIZE,
  getDiscordMessages,
  getReadableChannel,
  isDiscordAccessDenied,
  parseDiscordChannelUrl,
} from "../discord/client";
import { FetchFeedError } from "../fetcher/fetch-feed";
import type { Platform } from "../platform";
import type { FetchFeedOutcome } from "./fetch-feed";
import { nextFetchInterval } from "./fetch-interval";

export async function runFetchDiscord(
  platform: Pick<Platform, "db" | "fetch" | "discord" | "fetchConfig" | "retentionConfig" | "jobs">,
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

  const inserted = canStore
    ? await insertDiscordArticles(db, feed.id, discordConnectionId, articles)
    : 0;
  // 記事を入れ終えてから配り、配り終えてから次に取得する位置を記録する。
  await deliverNewArticles(db, { feedId: feed.id });
  if (!canStore && articles.length > 0) {
    await platform.jobs.enqueue([{ type: "clean-up" }]);
    return { status: "storage-full" };
  }
  const usage = await readStorageUsage(db);
  if (usage.bytes >= platform.retentionConfig.maxBytes * 0.9) {
    await platform.jobs.enqueue([{ type: "clean-up" }]);
  }

  const minMs = platform.fetchConfig.intervalMs;
  const interval =
    messages.length === DISCORD_PAGE_SIZE
      ? minMs
      : await nextFetchInterval(db, { feedId: feed.id, now: startedAt, minMs });
  await recordFetchSuccess(db, feed.id, {
    now: startedAt,
    nextFetchAt: new Date(startedAt.getTime() + interval),
    fetchIntervalMs: interval,
    etag: null,
    lastModified: null,
    title: channel.name,
    discord: { cursor, connectionId: discordConnectionId },
  });
  return messages.length === 0 ? { status: "not-modified" } : { status: "fetched", inserted };
}
