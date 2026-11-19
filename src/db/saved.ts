import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { sha256Hex } from "../lib/crypto";
import { type Database, getRow } from ".";
import { savedPageHorizons, savedPages } from "./schema";
import { nextSeq } from "./seq";

export const SAVED_PAGE_LIMITS = { active: 2000, total: 4000, url: 2048, title: 300 } as const;
export const SAVED_PAGE_REMOVAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export type SavedPage = { id: string; url: string; title: string | null; savedAt: Date };
export type SavedPageCursor = { at: number; id: string };

export function normalizeSavedUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password || url.href.length > SAVED_PAGE_LIMITS.url) return null;
    return url.href;
  } catch {
    return null;
  }
}

/**
 * 有効な行はそのまま返す。解除済みの行は同じ ID で保存し直す。
 * 件数の上限と保存結果は同じ文で決める。
 */
export async function savePage(
  db: Database,
  input: { userId: string; url: string; title: string | null; now: Date },
): Promise<SavedPage | null> {
  const { userId, url, title, now } = input;
  const id = await sha256Hex(url);
  const seq = nextSeq(savedPages);
  const row = await getRow<{ id: string; url: string; title: string | null; saved_at: number }>(
    db,
    sql`
    insert into saved_pages (user_id, id, url, title, saved_at, deleted_at, seq)
    select ${userId}, ${id}, ${url}, ${title}, ${now.getTime()}, null, ${seq}
    where exists (
      select 1 from saved_pages where user_id = ${userId} and id = ${id} and deleted_at is null
    ) or (
      select count(*) filter (where deleted_at is null) < ${SAVED_PAGE_LIMITS.active}
        and (count(*) < ${SAVED_PAGE_LIMITS.total} or max(id = ${id}) = 1)
      from saved_pages where user_id = ${userId}
    )
    on conflict (user_id, id) do update set
      url = coalesce(saved_pages.url, excluded.url),
      title = case when saved_pages.deleted_at is null then saved_pages.title else excluded.title end,
      saved_at = coalesce(saved_pages.saved_at, excluded.saved_at),
      seq = case when saved_pages.deleted_at is null then saved_pages.seq else excluded.seq end,
      deleted_at = null
    returning id, url, title, saved_at
  `,
  );
  return row
    ? { id: row.id, url: row.url, title: row.title, savedAt: new Date(row.saved_at) }
    : null;
}

export async function listSavedPages(
  db: Database,
  input: { userId: string; limit: number; cursor?: SavedPageCursor | undefined },
): Promise<{ items: SavedPage[]; next: SavedPageCursor | null }> {
  const { cursor, limit } = input;
  const rows = await db
    .select()
    .from(savedPages)
    .where(
      and(
        eq(savedPages.userId, input.userId),
        isNull(savedPages.deletedAt),
        cursor
          ? sql`(${savedPages.savedAt}, ${savedPages.id}) < (${cursor.at}, ${cursor.id})`
          : undefined,
      ),
    )
    .orderBy(desc(savedPages.savedAt), desc(savedPages.id))
    .limit(limit + 1)
    .all();
  const items = rows.slice(0, limit).map(toSavedPage);
  const last = items.at(-1);
  return {
    items,
    next: rows.length > limit && last ? { at: last.savedAt.getTime(), id: last.id } : null,
  };
}

/** sqlite の制約で、有効な行は URL と保存時刻を持つ。 */
export function toSavedPage(row: typeof savedPages.$inferSelect): SavedPage {
  if (row.url === null || row.savedAt === null) throw new Error("saved page has no URL or date");
  return { id: row.id, url: row.url, title: row.title, savedAt: row.savedAt };
}

export async function removeSavedPage(
  db: Database,
  input: { userId: string; id: string; now: Date },
): Promise<void> {
  await db
    .update(savedPages)
    .set({ url: null, title: null, savedAt: null, deletedAt: input.now, seq: nextSeq(savedPages) })
    .where(
      and(
        eq(savedPages.userId, input.userId),
        eq(savedPages.id, input.id),
        isNull(savedPages.deletedAt),
      ),
    )
    .run();
}

/** 削除と同じ文で、変更番号とユーザーごとの回収の下限をトリガーが引き上げる。 */
export async function collectDeletedSavedPages(
  db: Database,
  input: { before: Date; limit: number },
): Promise<number> {
  const rows = await db.all<{ id: string }>(sql`
    delete from saved_pages
    where rowid in (
      select rowid from saved_pages
      where deleted_at < ${input.before.getTime()}
      order by deleted_at limit ${input.limit}
    )
    returning id
  `);
  return rows.length;
}

export async function readSavedPageHorizon(db: Database, userId: string): Promise<number> {
  const row = await db
    .select({ seq: savedPageHorizons.seq })
    .from(savedPageHorizons)
    .where(eq(savedPageHorizons.userId, userId))
    .get();
  return row?.seq ?? 0;
}
