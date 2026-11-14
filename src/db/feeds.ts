import { and, asc, eq, inArray, isNull, lte } from "drizzle-orm";
import type { Database } from ".";
import { chunked } from "./chunk";
import { type Feed, feeds, folders, type NewFeed } from "./schema";

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
  input: { id: string; url: string; now: Date; folderId?: string | null; title?: string | null },
): Promise<{ feed: Feed; created: boolean }> {
  const inserted = await db
    .insert(feeds)
    .values({
      id: input.id,
      url: input.url,
      folderId: input.folderId ?? null,
      title: input.title ?? null,
      nextFetchAt: input.now,
      createdAt: input.now,
    })
    .onConflictDoNothing({ target: feeds.url })
    .returning()
    .get();
  if (inserted) return { feed: inserted, created: true };

  const existing = await findFeedByUrl(db, input.url);
  if (!existing) throw new Error(`feed disappeared while inserting: ${input.url}`);
  return { feed: existing, created: false };
}

/**
 * フィードを消す。記事は DB の ON DELETE CASCADE で一緒に消える
 * （articles の表は最初のマイグレーションで外部キーごと作っている）。
 * @returns 消したら true、なければ false
 */
export async function deleteFeed(db: Database, id: string): Promise<boolean> {
  const deleted = await db.delete(feeds).where(eq(feeds.id, id)).returning({ id: feeds.id }).get();
  return deleted !== undefined;
}

/** フィードのフォルダを変える。null ならフォルダなしにする。なければ undefined */
export async function setFeedFolder(
  db: Database,
  input: { id: string; folderId: string | null },
): Promise<Feed | undefined> {
  return db
    .update(feeds)
    .set({ folderId: input.folderId })
    .where(eq(feeds.id, input.id))
    .returning()
    .get();
}

/**
 * フィードをまとめて登録する。同じ URL がすでにあれば飛ばし、既存のフィードには触れない。
 * @returns 新しく登録したフィードの ID
 */
export async function insertFeeds(db: Database, rows: readonly NewFeed[]): Promise<string[]> {
  const created: string[] = [];
  for (const chunk of chunked(rows, feeds)) {
    const result = await db
      .insert(feeds)
      .values(chunk)
      .onConflictDoNothing({ target: feeds.url })
      .returning({ id: feeds.id })
      .all();
    created.push(...result.map((row) => row.id));
  }
  return created;
}

/**
 * フォルダに入っていないフィードだけを、フォルダに入れる。すでにフォルダがあれば変えない
 * （ユーザーが自分で整理した結果を上書きしないため）。
 */
export async function assignFolderIfMissing(
  db: Database,
  input: { folderId: string; urls: readonly string[] },
): Promise<void> {
  for (const chunk of chunked(input.urls, null)) {
    await db
      .update(feeds)
      .set({ folderId: input.folderId })
      .where(and(inArray(feeds.url, chunk), isNull(feeds.folderId)))
      .run();
  }
}

/** OPML に書き出すために、フィードをフォルダの名前と一緒に返す */
export async function listFeedsWithFolder(
  db: Database,
): Promise<(Feed & { folderName: string | null })[]> {
  const rows = await db
    .select({ feed: feeds, folderName: folders.name })
    .from(feeds)
    .leftJoin(folders, eq(feeds.folderId, folders.id))
    .orderBy(asc(folders.name), asc(feeds.createdAt), asc(feeds.id))
    .all();
  return rows.map((row) => ({ ...row.feed, folderName: row.folderName }));
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
