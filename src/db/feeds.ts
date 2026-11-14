import { asc, eq, inArray, lte } from "drizzle-orm";
import type { Database } from ".";
import { type Feed, feeds } from "./schema";

export async function findFeedByUrl(db: Database, url: string): Promise<Feed | undefined> {
  return db.select().from(feeds).where(eq(feeds.url, url)).get();
}

export async function getFeed(db: Database, id: string): Promise<Feed | undefined> {
  return db.select().from(feeds).where(eq(feeds.id, id)).get();
}

export async function listFeeds(db: Database): Promise<Feed[]> {
  return db.select().from(feeds).orderBy(asc(feeds.createdAt), asc(feeds.id)).all();
}

/**
 * フィードを登録する。同じ URL がすでにあれば、それを返す。
 * 2つの登録が同時に来ても、URL の一意制約で1件にまとまる。
 */
export async function insertFeed(
  db: Database,
  input: { id: string; url: string; now: Date },
): Promise<{ feed: Feed; created: boolean }> {
  const inserted = await db
    .insert(feeds)
    .values({ id: input.id, url: input.url, nextFetchAt: input.now, createdAt: input.now })
    .onConflictDoNothing({ target: feeds.url })
    .returning()
    .get();
  if (inserted) return { feed: inserted, created: true };

  const existing = await findFeedByUrl(db, input.url);
  if (!existing) throw new Error(`feed disappeared while inserting: ${input.url}`);
  return { feed: existing, created: false };
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
  // D1 は1つの文に渡せる変数が 100 個まで。IN 句と更新値の分を残して上限を設ける
  if (input.limit < 1 || input.limit > MAX_LEASE) {
    throw new RangeError(`limit must be between 1 and ${MAX_LEASE}`);
  }
  const due = await db
    .select({ id: feeds.id })
    .from(feeds)
    .where(lte(feeds.nextFetchAt, input.now))
    .orderBy(asc(feeds.nextFetchAt))
    .limit(input.limit)
    .all();
  if (due.length === 0) return [];

  const ids = due.map(({ id }) => id);
  await db.update(feeds).set({ nextFetchAt: input.leaseUntil }).where(inArray(feeds.id, ids));
  return ids;
}

export async function recordFetchSuccess(
  db: Database,
  id: string,
  input: {
    now: Date;
    nextFetchAt: Date;
    etag: string | null;
    lastModified: string | null;
    title?: string | null;
    siteUrl?: string | null;
  },
): Promise<void> {
  await db
    .update(feeds)
    .set({
      etag: input.etag,
      lastModified: input.lastModified,
      lastFetchedAt: input.now,
      nextFetchAt: input.nextFetchAt,
      errorCount: 0,
      lastError: null,
      ...(input.title !== undefined && { title: input.title }),
      ...(input.siteUrl !== undefined && { siteUrl: input.siteUrl }),
    })
    .where(eq(feeds.id, id));
}

export async function recordFetchFailure(
  db: Database,
  id: string,
  input: { now: Date; nextFetchAt: Date; errorCount: number; error: string },
): Promise<void> {
  await db
    .update(feeds)
    .set({
      lastFetchedAt: input.now,
      nextFetchAt: input.nextFetchAt,
      errorCount: input.errorCount,
      lastError: input.error,
    })
    .where(eq(feeds.id, id));
}
