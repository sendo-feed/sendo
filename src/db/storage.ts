import { sql } from "drizzle-orm";
import { type Database, getRow } from ".";
import { DB_NOW_MS } from "./clock";

/** 書き込みと同時にトリガーが集計した使用量。未集計の本文があれば削除しない */
export async function readStorageUsage(
  db: Database,
): Promise<{ bytes: number; unmeasured: number; reclaiming: boolean; limitBytes: number }> {
  const row = await getRow<{
    bytes: number;
    unmeasured: number;
    reclaiming: boolean;
    limitBytes: number;
  }>(
    db,
    sql`
    select bytes, reclaiming, limit_bytes as limitBytes, (select count(*) from content_sizes where bytes is null) as unmeasured
    from storage_usage where id = 1
  `,
  );
  if (!row) throw new Error("storage accounting is not initialized");
  return row;
}

/** 保存のトリガーも同じ上限を見る。設定を読み違えたときは既定に戻さず呼ぶ側で例外にする */
export async function configureStorage(db: Database, maxBytes: number): Promise<void> {
  await db.run(sql`update storage_usage set limit_bytes = ${maxBytes}
    where id = 1 and limit_bytes != ${maxBytes}`);
}

// フィードに載っている記事と、誰かがスターを付けた記事は候補にしない。
const evictable = sql`(
  a.in_current_feed = 0 or not exists (
    select 1 from subscriptions s where s.feed_id = a.feed_id and s.deleted_at is null
  )
) and not exists (
  select 1 from user_articles u where u.article_id = a.id and u.starred_at is not null
)`;

/** 古い順に候補を読む。削除と同じ文でも条件を確かめ直す */
export async function readEvictionCandidates(
  db: Database,
  limit: number,
  desiredBytes = Number.POSITIVE_INFINITY,
): Promise<string[]> {
  // トリガーの集計と同じ文字列のバイト数を使い、長い日本語の項目を固定 2 KiB と見積もらない。
  const fields = [
    "id",
    "feed_id",
    "guid",
    "url",
    "title",
    "summary",
    "author",
    "thumbnail_url",
    "content_key",
  ];
  const metadata = sql.join(
    fields.map((field) => sql`coalesce(length(cast(a.${sql.identifier(field)} as blob)), 0)`),
    sql` + `,
  );
  const rows = await db.all<{ id: string; bytes: number }>(sql`select a.id,
    2048 + ${metadata} + a.reserved_inbox_bytes + a.reserved_inbox_bytes
    + coalesce((select bytes + article_bytes + 256 from content_sizes where key = a.content_key), 0)
    + coalesce((select length(cast(html as blob)) + 256 from page_contents where article_id = a.id), 0)
    + (select count(*) * 512 from article_languages where article_id = a.id)
    + coalesce((select 256 + coalesce(length(embedding), 0) from article_analyses where article_id = a.id), 0)
    + coalesce((select sum(128 + length(cast(key as blob)) + length(cast(surface as blob)))
      from article_candidates where article_id = a.id), 0)
    + coalesce((select sum(128 + length(cast(name as blob))) from article_categories
      where article_id = a.id), 0)
    + coalesce((select 512 + coalesce(length(cast(t.title as blob)), 0)
      + coalesce(length(cast(t.summary as blob)), 0) + coalesce(length(cast(t.model as blob)), 0)
      + coalesce(length(cast(t.content as blob)), 0)
      from article_translations t where t.article_id = a.id), 0)
    + coalesce((select bytes from article_search_documents where article_id = a.id), 0)
    + (select count(*) * 512 from user_articles u where u.article_id = a.id)
    - (select count(*) * 256 from user_articles u where u.article_id = a.id
      and not exists (select 1 from user_article_removals r where r.user_id = u.user_id and r.article_id = u.article_id))
    as bytes from articles a
    where ${evictable} order by a.created_at, a.id limit ${limit}`);
  const ids: string[] = [];
  let bytes = 0;
  for (const row of rows) {
    if (bytes >= desiredBytes) break;
    ids.push(row.id);
    bytes += row.bytes;
  }
  return ids;
}

/** 受信箱を先に、共有の記事を後に消す。競合してスター・受信箱が増えた記事は保護する */
export async function evictArticles(
  db: Database,
  ids: readonly string[],
  reclaimToken?: string,
): Promise<{ inbox: number; articles: number }> {
  if (ids.length === 0) return { inbox: 0, articles: 0 };
  const owned =
    reclaimToken === undefined
      ? sql`1`
      : sql`exists (
    select 1 from storage_usage where id = 1 and reclaim_token = ${reclaimToken}
      and reclaim_until > ${DB_NOW_MS} and bytes > limit_bytes * 0.8
  )`;
  const chosen = sql`a.id in (select value from json_each(${JSON.stringify(ids)}))`;
  const inbox = await db.all<{ id: string }>(sql`delete from user_articles
    where article_id in (select a.id from articles a where ${chosen} and ${evictable} and ${owned})
    returning article_id as id`);
  const articles = await db.all<{ id: string }>(sql`delete from articles
    where id in (select a.id from articles a where ${chosen} and ${evictable} and ${owned}
      and not exists (select 1 from user_articles u where u.article_id = a.id))
    returning id`);
  return { inbox: inbox.length, articles: articles.length };
}

/** SQLite の容量拒否。Drizzle はドライバの例外を cause に包む */
export function isStorageLimitError(error: unknown): boolean {
  let cause = error;
  for (let depth = 0; depth < 8 && cause instanceof Error; depth++) {
    if (cause.message.includes("SENDO_STORAGE_LIMIT")) return true;
    cause = cause.cause;
  }
  return false;
}
