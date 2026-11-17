import { sql } from "drizzle-orm";
import {
  configureStorage,
  evictArticles,
  readEvictionCandidates,
  readStorageUsage,
} from "../db/storage";
import type { Platform } from "../platform";

/** Cloudflare の仕事 1 つのクエリ数・書き込み量に収める */
export const EVICTION_BATCH = 100;
export const MEASUREMENT_BATCH = 30;

/** 既存本文を少しずつ測る。集計の途中では新規取り込み・容量による削除を始めない */
export async function measureExistingContents(
  platform: Pick<Platform, "db" | "content">,
): Promise<void> {
  const rows = await platform.db.all<{ key: string }>(sql`select key from content_sizes
    where bytes is null limit ${MEASUREMENT_BATCH}`);
  if (rows.length === 0) return;
  const sizes = await Promise.all(
    rows.map(async ({ key }) => {
      const content = await platform.content.get(key);
      return { key, bytes: new TextEncoder().encode(content ?? "").length };
    }),
  );
  await platform.db.run(sql`update content_sizes set bytes = (
    select json_extract(value, '$.bytes') from json_each(${JSON.stringify(sizes)})
    where json_extract(value, '$.key') = content_sizes.key
  ) where bytes is null and key in (
    select json_extract(value, '$.key') from json_each(${JSON.stringify(sizes)})
  )`);
}

/** 保存前の確認。最終的な容量の確認は、それぞれの INSERT のトリガーでも行う */
export async function canStoreArticles(
  platform: Pick<Platform, "db" | "retentionConfig">,
): Promise<boolean> {
  const usage = await readStorageUsage(platform.db);
  if (usage.limitBytes !== platform.retentionConfig.maxBytes) {
    await configureStorage(platform.db, platform.retentionConfig.maxBytes);
  }
  if (usage.unmeasured > 0 || usage.bytes >= platform.retentionConfig.maxBytes) {
    reportStorageFull(platform, usage);
    return false;
  }
  return true;
}

export function reportStorageFull(
  platform: Pick<Platform, "retentionConfig">,
  usage?: { bytes: number; unmeasured: number },
): void {
  console.warn("storage_limit_reached", {
    limitBytes: platform.retentionConfig.maxBytes,
    ...(usage && { usedBytes: usage.bytes, unmeasuredContents: usage.unmeasured }),
  });
}

/** 90% から片付け、80% で止める。1 回で足りなければ次の仕事に回す */
export async function reclaimStorage(
  platform: Pick<Platform, "db" | "retentionConfig">,
): Promise<{ inbox: number; articles: number }> {
  await configureStorage(platform.db, platform.retentionConfig.maxBytes);
  await platform.db.run(sql`update storage_usage set reclaiming = case
    when bytes >= limit_bytes * 0.9 then 1
    when bytes <= limit_bytes * 0.8 then 0
    else reclaiming end where id = 1`);
  const usage = await readStorageUsage(platform.db);
  if (usage.unmeasured > 0 || !usage.reclaiming) return { inbox: 0, articles: 0 };
  // 取得が一度に容量を圧迫しても、片付けで Cloudflare の日ごとの書き込み量を使い切らない。
  // 1 回 100 記事、UTC の 1 日に 10 回まで。確認と確保は同じ UPDATE で行う。
  const claimed = await platform.db.get<{ id: number }>(sql`update storage_usage set
    eviction_batches = case when eviction_day = cast(unixepoch() / 86400 as integer)
      then eviction_batches + 1 else 1 end,
    eviction_day = cast(unixepoch() / 86400 as integer)
    where id = 1 and (eviction_day != cast(unixepoch() / 86400 as integer) or eviction_batches < 10)
    returning id`);
  if (!claimed) return { inbox: 0, articles: 0 };
  const pending = await platform.db.get<{
    bytes: number;
  }>(sql`select coalesce(sum(s.bytes), 0) as bytes
    from content_notes n join content_sizes s on s.key = n.key
    where not exists (select 1 from articles a where a.content_key = n.key)`);
  const desiredBytes =
    usage.bytes - (pending?.bytes ?? 0) - platform.retentionConfig.maxBytes * 0.8;
  if (desiredBytes <= 0) return { inbox: 0, articles: 0 };
  const candidates = await readEvictionCandidates(platform.db, EVICTION_BATCH, desiredBytes);
  if (candidates.length === 0) reportStorageFull(platform, usage);
  return evictArticles(platform.db, candidates);
}
