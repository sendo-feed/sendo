import { and, eq, isNull, sql } from "drizzle-orm";
import type { Database } from ".";
import { randomItemId } from "./articles";
import { DB_NOW_MS } from "./clock";
import { discordConnections, type Feed, feeds, subscriptions } from "./schema";
import { nextSeq } from "./seq";
import { activeFolderId, getSubscription } from "./subscriptions";

export async function getDiscordConnection(db: Database, userId: string) {
  return db.select().from(discordConnections).where(eq(discordConnections.userId, userId)).get();
}

export async function connectDiscord(db: Database, userId: string, discordUserId: string) {
  const row = await db
    .insert(discordConnections)
    .values({ id: crypto.randomUUID(), userId, discordUserId })
    .onConflictDoNothing({ target: discordConnections.userId })
    .returning()
    .get();
  if (row) return true;
  return (await getDiscordConnection(db, userId))?.discordUserId === discordUserId;
}

export async function disconnectDiscord(db: Database, userId: string) {
  await db.delete(discordConnections).where(eq(discordConnections.userId, userId)).run();
}

export async function listDiscordSubscriptions(db: Database, userId: string) {
  return db
    .select({ feedId: feeds.id, url: feeds.url, name: feeds.title })
    .from(feeds)
    .innerJoin(discordConnections, eq(feeds.discordConnectionId, discordConnections.id))
    .innerJoin(subscriptions, eq(subscriptions.feedId, feeds.id))
    .where(
      and(
        eq(discordConnections.userId, userId),
        eq(subscriptions.userId, userId),
        isNull(subscriptions.deletedAt),
      ),
    )
    .orderBy(feeds.title, feeds.id)
    .all();
}

export async function addDiscordSubscription(
  db: Database,
  input: {
    userId: string;
    connectionId: string;
    url: string;
    name: string;
    cursor: string;
    folderId: string | null;
    now: Date;
  },
): Promise<{ feed: Feed; created: boolean } | null> {
  const { userId, connectionId, url, name, cursor, folderId, now } = input;
  const belongsToUser = and(
    eq(discordConnections.id, connectionId),
    eq(discordConnections.userId, userId),
  );
  await db.run(sql`
    insert into feeds (id, url, title, site_url, discord_connection_id, discord_cursor, next_fetch_at, created_at)
    select ${crypto.randomUUID()}, ${url}, ${name}, ${url}, id, ${cursor}, ${now.getTime()}, ${now.getTime()}
    from discord_connections where ${belongsToUser}
    on conflict (discord_connection_id, url) do nothing
  `);
  const feed = await db
    .select({ feed: feeds })
    .from(feeds)
    .innerJoin(discordConnections, eq(feeds.discordConnectionId, discordConnections.id))
    .where(and(belongsToUser, eq(feeds.url, url)))
    .get();
  if (!feed) return null;

  const subscription = await db.get<{ id: string }>(sql`
    insert into subscriptions (id, user_id, feed_id, folder_id, created_at, backfilled_at, seq)
    select ${crypto.randomUUID()}, ${userId}, ${feeds.id}, ${activeFolderId(userId, folderId)},
      ${now.getTime()}, ${now.getTime()}, ${nextSeq(subscriptions)}
    from ${feeds}
    where ${feeds.id} = ${feed.feed.id} and ${feeds.discordConnectionId} = ${connectionId}
    on conflict do nothing
    returning id
  `);
  if (!subscription && !(await getSubscription(db, { userId, feedId: feed.feed.id }))) return null;
  return { feed: feed.feed, created: subscription !== undefined };
}

/** ジョブが動き出した時点で有効な接続と購読を取る */
export async function getDiscordSubscriber(db: Database, feed: Feed) {
  const connectionId = feed.discordConnectionId;
  if (!connectionId) return undefined;
  return db
    .select({ discordUserId: discordConnections.discordUserId })
    .from(discordConnections)
    .innerJoin(subscriptions, eq(subscriptions.userId, discordConnections.userId))
    .where(
      and(
        eq(discordConnections.id, connectionId),
        eq(subscriptions.feedId, feed.id),
        isNull(subscriptions.deletedAt),
      ),
    )
    .get();
}

/** 読めなくなった場合、取り込み先を閉じ、記事と購読の削除を同期で伝える */
export async function detachDiscordFeed(db: Database, feedId: string, connectionId: string) {
  await db
    .update(feeds)
    .set({ discordConnectionId: null })
    .where(and(eq(feeds.id, feedId), eq(feeds.discordConnectionId, connectionId)))
    .run();
}

export type DiscordArticle = {
  guid: string;
  url: string;
  title: string;
  summary: string | null;
  author: string;
  publishedAt: number;
};

/** 取得中に連携や購読が解除されたら、保存しない。メッセージ ID で重複を防ぐ */
export async function insertDiscordArticles(
  db: Database,
  feedId: string,
  connectionId: string,
  articles: readonly DiscordArticle[],
) {
  if (articles.length === 0) return 0;
  const rows = articles.map((row) => ({ ...row, id: crypto.randomUUID(), itemId: randomItemId() }));
  const inserted = await db.all<{ id: string }>(sql`
    insert into articles (
      id, feed_id, guid, url, title, summary, author, published_at, created_at, item_id, in_current_feed
    )
    select
      value ->> '$.id', ${feedId}, value ->> '$.guid', value ->> '$.url',
      value ->> '$.title', value ->> '$.summary', value ->> '$.author',
      value ->> '$.publishedAt', ${DB_NOW_MS}, value ->> '$.itemId', 0
    from json_each(${JSON.stringify(rows)})
    where exists (
      select 1 from feeds inner join subscriptions on subscriptions.feed_id = feeds.id
      where feeds.id = ${feedId} and feeds.discord_connection_id = ${connectionId}
        and subscriptions.deleted_at is null
    )
    on conflict (feed_id, guid) do nothing
    returning id
  `);
  return inserted.length;
}
