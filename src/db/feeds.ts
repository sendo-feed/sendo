import { and, asc, eq, exists, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { Database } from ".";
import { chunked } from "./chunk";
import { type Feed, type FeedErrorCode, feeds, type NewFeed, subscriptions } from "./schema";

/*
 * フィードは全員で共有する。誰がどのフォルダで購読しているかは subscriptions.ts。
 */

export async function findFeedByUrl(db: Database, url: string): Promise<Feed | undefined> {
  return db
    .select()
    .from(feeds)
    .where(and(eq(feeds.url, url), isNull(feeds.discordCursor)))
    .get();
}

export async function getFeed(db: Database, id: string): Promise<Feed | undefined> {
  return db.select().from(feeds).where(eq(feeds.id, id)).get();
}

/** URL を使う公開購読の入口から、Discord のフィードを引けないようにする */
export async function getPublicFeed(db: Database, id: string): Promise<Feed | undefined> {
  return db
    .select()
    .from(feeds)
    .where(and(eq(feeds.id, id), isNull(feeds.discordCursor)))
    .get();
}

/**
 * フィードを登録する。同じ URL がすでにあれば、それを返す。
 * 2つの登録が同時に来ても、URL の一意制約で1件にまとまる。
 */
export async function insertFeed(
  db: Database,
  input: { id: string; url: string; now: Date; title?: string | null },
): Promise<{ feed: Feed; created: boolean }> {
  const inserted = await db
    .insert(feeds)
    .values({
      id: input.id,
      url: input.url,
      title: input.title ?? null,
      nextFetchAt: input.now,
      createdAt: input.now,
    })
    .onConflictDoNothing()
    .returning()
    .get();
  if (inserted) return { feed: inserted, created: true };

  const existing = await findFeedByUrl(db, input.url);
  if (!existing) throw new Error(`feed disappeared while inserting: ${input.url}`);
  return { feed: existing, created: false };
}

/**
 * フィードをまとめて登録する。同じ URL がすでにあれば飛ばす。
 * @returns 新しく登録したフィードの ID
 */
export async function insertFeeds(db: Database, rows: readonly NewFeed[]): Promise<string[]> {
  const created: string[] = [];
  for (const chunk of chunked(rows, feeds)) {
    const result = await db
      .insert(feeds)
      .values(chunk)
      .onConflictDoNothing()
      .returning({ id: feeds.id })
      .all();
    created.push(...result.map((row) => row.id));
  }
  return created;
}

/** URL からフィードの ID を引く表。ないものは含まない */
export async function findFeedIdsByUrls(
  db: Database,
  urls: readonly string[],
): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const chunk of chunked([...new Set(urls)], null)) {
    const rows = await db
      .select({ id: feeds.id, url: feeds.url })
      .from(feeds)
      .where(and(inArray(feeds.url, chunk), isNull(feeds.discordCursor)))
      .all();
    for (const row of rows) ids.set(row.url, row.id);
  }
  return ids;
}

/** 一度に借りられるフィードの数の上限 */
export const MAX_LEASE = 90;

/**
 * 取得の時期が来たフィードを選び、次の取得の時刻を先に進めて「借りる」。
 * 同じフィードが、取得の終わる前に何度もキューへ積まれるのを防ぐ。
 */
export async function leaseDueFeeds(
  db: Database,
  input: { now: Date; leaseUntil: Date; limit: number },
): Promise<string[]> {
  // 1 つの文の変数は MAX_BOUND_PARAMETERS（db/chunk.ts）まで。IN 句と更新値の分を残して上限を設ける
  if (input.limit < 1 || input.limit > MAX_LEASE) {
    throw new RangeError(`limit must be between 1 and ${MAX_LEASE}`);
  }
  // 購読している人がいないフィードは取得しない（docs/decisions/accounts.md）
  const subscribed = exists(
    db
      .select({ one: sql`1` })
      .from(subscriptions)
      .where(and(eq(subscriptions.feedId, feeds.id), isNull(subscriptions.deletedAt))),
  );
  const due = await db
    .select({ id: feeds.id })
    .from(feeds)
    .where(and(isNull(feeds.discordCursor), lte(feeds.nextFetchAt, input.now), subscribed))
    .orderBy(asc(feeds.nextFetchAt))
    .limit(input.limit)
    .all();
  if (due.length === 0) return [];

  const ids = due.map(({ id }) => id);
  const leased = await db
    .update(feeds)
    .set({ nextFetchAt: input.leaseUntil })
    .where(and(inArray(feeds.id, ids), lte(feeds.nextFetchAt, input.now), subscribed))
    .returning({ id: feeds.id })
    .all();
  const leasedIds = new Set(leased.map(({ id }) => id));
  return ids.filter((id) => leasedIds.has(id));
}

type FetchTarget = Pick<Feed, "id" | "lastFetchedAt" | "discordConnectionId" | "discordCursor">;

function fetchedBefore(now: Date) {
  return or(isNull(feeds.lastFetchedAt), lt(feeds.lastFetchedAt, now));
}

export async function recordFetchSuccess(
  db: Database,
  id: string,
  input: {
    now: Date;
    nextFetchAt: Date;
    /** 決め直した取得の間隔（docs/decisions/jobs.md の 7、11）。次の取得までの長さ */
    fetchIntervalMs: number;
    etag?: string | null;
    lastModified?: string | null;
    discord?: {
      cursor: string;
      connectionId: string;
      previousCursor: string;
      previousFetchedAt: Date | null;
    };
    /**
     * Discord のサーバーのアイコン（docs/decisions/discord.md の 7）。undefined なら変えない。
     * iconCheckedAt（discord.com を探した時刻）は進めない
     */
    iconUrl?: string | undefined;
    title?: string | null;
    siteUrl?: string | null;
  },
): Promise<Pick<Feed, "id" | "siteUrl" | "iconUrl" | "iconCheckedAt"> | undefined> {
  const sameConnection = input.discord && eq(feeds.discordConnectionId, input.discord.connectionId);
  // 直列に動く Discord の取得では、時計の順序ではなく、読み取った取得位置と記録を確かめる。
  const current = input.discord
    ? and(
        sameConnection,
        eq(feeds.discordCursor, input.discord.previousCursor),
        sql`${feeds.lastFetchedAt} IS ${input.discord.previousFetchedAt?.getTime() ?? null}`,
      )
    : fetchedBefore(input.now);
  const recorded = await db
    .update(feeds)
    .set({
      ...(input.etag !== undefined && { etag: input.etag }),
      ...(input.lastModified !== undefined && { lastModified: input.lastModified }),
      lastFetchedAt: input.now,
      lastSuccessfulFetchAt: input.now,
      nextFetchAt: input.nextFetchAt,
      fetchIntervalMs: input.fetchIntervalMs,
      errorCount: 0,
      lastError: null,
      lastErrorCode: null,
      failureStartedAt: null,
      fetchStalled: false,
      relocationCandidate: null,
      ...(input.discord && {
        discordCursor: sql`case when
          (length(${input.discord.cursor}), ${input.discord.cursor}) >
          (length(${feeds.discordCursor}), ${feeds.discordCursor})
          then ${input.discord.cursor} else ${feeds.discordCursor} end`,
      }),
      ...(input.title !== undefined && { title: input.title }),
      ...(input.siteUrl !== undefined && { siteUrl: input.siteUrl }),
      ...(input.iconUrl !== undefined && { iconUrl: input.iconUrl }),
    })
    .where(and(eq(feeds.id, id), current))
    .returning({
      id: feeds.id,
      siteUrl: feeds.siteUrl,
      iconUrl: feeds.iconUrl,
      iconCheckedAt: feeds.iconCheckedAt,
    })
    .get();
  if (!recorded) {
    // 後から始めた試行が先に記録されていても、この成功の時刻は残す。
    await db
      .update(feeds)
      .set({ lastSuccessfulFetchAt: input.now })
      .where(
        and(
          eq(feeds.id, id),
          sameConnection,
          or(isNull(feeds.lastSuccessfulFetchAt), lt(feeds.lastSuccessfulFetchAt, input.now)),
        ),
      );
  }
  return recorded;
}

/**
 * アイコンを探した結果を記録する（docs/decisions/images.md の 8）。見つからなければ null。
 * アイコンが変わると、購読の変更番号はトリガーが進める（migrations/0016_feed_icon_trigger.sql）
 */
export async function recordFeedIcon(
  db: Database,
  id: string,
  input: { iconUrl: string | null; now: Date },
): Promise<void> {
  await db
    .update(feeds)
    .set({ iconUrl: input.iconUrl, iconCheckedAt: input.now })
    .where(eq(feeds.id, id));
}

/**
 * Discord のフィードで、サーバーにアイコンがないときに discord.com を探した結果を記録する
 * （docs/decisions/discord.md の 7）。探し始めたときのアイコン（expected）が変わっておらず、最後に記録した
 * 取得がこの取得（fetchedAt）で、同じ接続のときだけ記録する（同じ文の中で確かめる）。探している間に、
 * 後から始めた取得がサーバーのアイコンを記録していたら、同じ値を書き直しただけでも、そちらを残す。
 * アイコンが変わると、購読の変更番号はトリガーが進める
 * @returns 記録したか
 */
export async function recordDiscordSiteIcon(
  db: Database,
  id: string,
  input: {
    connectionId: string;
    expected: string | null;
    iconUrl: string | null;
    /** この取得を始めた時刻。取得の記録（recordFetchSuccess）の now と同じ */
    fetchedAt: Date;
  },
): Promise<boolean> {
  const recorded = await db
    .update(feeds)
    .set({ iconUrl: input.iconUrl, iconCheckedAt: input.fetchedAt })
    .where(
      and(
        eq(feeds.id, id),
        eq(feeds.discordConnectionId, input.connectionId),
        eq(feeds.lastFetchedAt, input.fetchedAt),
        input.expected === null ? isNull(feeds.iconUrl) : eq(feeds.iconUrl, input.expected),
      ),
    )
    .returning({ id: feeds.id })
    .get();
  return recorded !== undefined;
}

export async function recordFetchFailure(
  db: Database,
  feed: FetchTarget,
  input: {
    now: Date;
    nextFetchAt: Date;
    errorCount: number;
    error: string;
    errorCode: FeedErrorCode;
    failureStartedAt: Date | null;
    fetchStalled: boolean;
    relocationCandidate?: Feed["relocationCandidate"] | undefined;
  },
): Promise<boolean> {
  const previous = feed.lastFetchedAt?.getTime() ?? null;
  const updated = await db
    .update(feeds)
    .set({
      lastFetchedAt: input.now,
      nextFetchAt: input.nextFetchAt,
      errorCount: input.errorCount,
      lastError: input.error,
      lastErrorCode: input.errorCode,
      failureStartedAt: input.failureStartedAt,
      fetchStalled: input.fetchStalled,
      ...(input.relocationCandidate !== undefined && {
        relocationCandidate: input.relocationCandidate,
      }),
    })
    // 失敗回数と次の間隔は、呼び出し元が読んだ結果がまだ最新のときだけ書く
    .where(
      and(
        eq(feeds.id, feed.id),
        feed.discordCursor === null
          ? fetchedBefore(input.now)
          : eq(feeds.discordCursor, feed.discordCursor),
        sql`${feeds.discordConnectionId} IS ${feed.discordConnectionId}`,
        sql`${feeds.lastFetchedAt} IS ${previous}`,
      ),
    )
    .returning({ id: feeds.id })
    .get();
  return updated !== undefined;
}
