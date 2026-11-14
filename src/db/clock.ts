import { sql } from "drizzle-orm";
import type { Database } from ".";

/**
 * DB の時計での「今」（ミリ秒）を、SQL の式として返す。
 *
 * 記事を取り込んだ時刻と、一覧が「いつ時点のものか」（asOf）を同じ DB の時計で決めると、
 * 時計のずれに左右されずに前後を比べられる。D1 は読み書きを 1 つずつ順に処理するので、
 * 一覧を読んだ時点で見えなかった記事は、必ず asOf より後の時刻になる。
 * （unixepoch('subsec') は SQLite 3.42 以降。Postgres に移すときは now() に置き換える）
 */
export const DB_NOW_MS = sql<number>`cast(unixepoch('subsec') * 1000 as integer)`;

/** DB の時計での「今」 */
export async function dbNow(db: Database): Promise<Date> {
  const row = await db.get<{ now: number }>(sql`select ${DB_NOW_MS} as now`);
  return new Date(row.now);
}
