import { estimateArticleBytes } from "../db/articles";
import {
  clearUsedContentNotes,
  findExistingGuids,
  MAX_CONTENT_BYTES,
  noteContentKeys,
  reserveContents,
} from "../db/content";
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
import { toDiscordPost } from "../discord/message";
import { FetchFeedError } from "../fetcher/fetch-feed";
import { sanitizeHtml } from "../lib/sanitize-html";
import type { Platform } from "../platform";
import type { FetchFeedOutcome } from "./fetch-feed";
import { nextFetchInterval } from "./fetch-slots";
import { reportStorageFull } from "./storage";

export async function runFetchDiscord(
  platform: Pick<
    Platform,
    | "db"
    | "fetch"
    | "discord"
    | "content"
    | "fetchConfig"
    | "retentionConfig"
    | "jobs"
    | "syncUpdates"
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
  const htmls = new Map<string, string>();
  for (const message of messages) {
    if (BigInt(message.id) > BigInt(cursor)) cursor = message.id;
    // 通常の投稿と返信に絞る。システムメッセージには受信箱の行を作らない。
    if (message.type !== 0 && message.type !== 19) continue;
    if (!message.content.trim() && message.attachments.length === 0 && message.embeds.length === 0)
      continue;
    const post = toDiscordPost(message);
    const url = `${feed.url}/${message.id}`;
    articles.push({
      id: crypto.randomUUID(),
      guid: message.id,
      url,
      title: post.title,
      summary: post.summary,
      author: message.author.global_name || message.author.username,
      publishedAt: Date.parse(message.timestamp),
      contentKey: null,
    });
    if (post.html !== null) htmls.set(message.id, sanitizeHtml(post.html, url));
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

  let inserted = 0;
  if (canStore) {
    // 本文を、記事の行を入れる前に置く（docs/decisions/content.md の 4）
    const stored = await storeDiscordContents(platform, feed.id, articles, htmls);
    inserted = await insertDiscordArticles(
      db,
      feed.id,
      discordConnectionId,
      articles.filter((article) => !stored.deferred.has(article.guid)),
    );
    // 行に入った名前の書き留めを消す。入らなかった名前は残り、1 日 1 回の片付けが本文を消す
    await clearUsedContentNotes(db, stored.keys);
  }
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
    discord: { cursor, connectionId: discordConnectionId },
  });
  return messages.length === 0 ? { status: "not-modified" } : { status: "fetched", inserted };
}

/**
 * 新しい投稿の本文を置き場に置き、置いた名前を articles に入れる（docs/decisions/discord.md の 6、
 * docs/decisions/content.md の 3、4）。公開フィードの本文と同じく、置く前に名前を書き留め、
 * 容量を確保してから置く。要約と同じ中身でも置く。
 *
 * @returns 置いた本文の名前と、容量が足りず、記事ごと次の取得に回す投稿の guid
 */
async function storeDiscordContents(
  platform: Pick<Platform, "db" | "content">,
  feedId: string,
  articles: DiscordArticle[],
  htmls: ReadonlyMap<string, string>,
): Promise<{ keys: string[]; deferred: Set<string> }> {
  const { db } = platform;
  const withContent = articles.filter((article) => htmls.has(article.guid));
  if (withContent.length === 0) return { keys: [], deferred: new Set() };
  const existing = await findExistingGuids(db, {
    feedId,
    guids: withContent.map((article) => article.guid),
  });
  const encoder = new TextEncoder();
  const contents: { article: DiscordArticle; key: string; html: string; bytes: number }[] = [];
  for (const article of withContent) {
    const html = htmls.get(article.guid);
    if (html === undefined || html === "" || existing.has(article.guid)) continue;
    const bytes = encoder.encode(html).length;
    if (bytes > MAX_CONTENT_BYTES) continue;
    contents.push({ article, key: newContentKey(), html, bytes });
  }
  if (contents.length === 0) return { keys: [], deferred: new Set() };

  await noteContentKeys(
    db,
    contents.map(({ key }) => key),
  );
  const reserved = await reserveContents(
    db,
    contents.map(({ article, key, bytes }) => ({
      key,
      bytes,
      articleBytes: estimateArticleBytes({
        ...article,
        publishedAt: new Date(article.publishedAt),
        feedId,
        contentKey: key,
      }),
      feedId,
    })),
  );
  const stored = contents.filter(({ key }) => reserved.has(key));
  await Promise.all(stored.map(({ key, html }) => platform.content.put(key, html)));
  for (const { article, key } of stored) article.contentKey = key;
  return {
    keys: stored.map(({ key }) => key),
    deferred: new Set(
      contents.filter(({ key }) => !reserved.has(key)).map(({ article }) => article.guid),
    ),
  };
}

/** 本文の置き場の名前。置くたびに乱数で決める */
function newContentKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `feed/${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}
