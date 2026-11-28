/**
 * DB（docs/decisions/container.md の 5）。SQLite のファイルを libsql で開く。
 */
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import type { Database } from "../../db";
import * as schema from "../../db/schema";

/** 接続の待ち時間（busy_timeout。ミリ秒）。重い読み取りの接続（heavy-read.ts）にも同じものを付ける */
export const BUSY_TIMEOUT_MS = 5000;

export interface OpenedDatabase {
  db: Database;
  close(): void;
}

/**
 * SQLite のファイルを開き、マイグレーションを当てる。url は libsql の形（file:/data/sendo.db、テストでは :memory:）。
 *
 * 外部キーを効かせる（スキーマの ON DELETE CASCADE を使う）。書き込みは 1 つのプロセスからだけなので
 * （決定の 7）、WAL にして、読むのが書くのを待たないようにする
 */
export async function openDatabase(
  url: string,
  options: { migrationsFolder: string },
): Promise<OpenedDatabase> {
  // 接続は 1 本にする（sendo-feed/sendo#215）。libsql のクライアントは既定で接続を最大 20 本持ち、
  // 重なった呼び出しに別々の接続を使う。ある接続が書き込みのロックや読み取りのスナップショットを
  // 持っている間に別の接続が書くと、SQLITE_BUSY（待ち時間のない接続では、すぐに）や
  // SQLITE_BUSY_SNAPSHOT（WAL で、待っても防げない）になる。1 本なら、プロセスの中にその別の接続が
  // ない。書くのは 1 つのプロセスだけで、文は 1 つずつ同期して動くので、接続を増やしても速くならない。
  // 1 本なので、トランザクション（client.transaction）を開くと、その間ほかの呼び出しは
  // TRANSACTION_ACTIVE で失敗する。トランザクションは使わない（docs/decisions/tech-stack.md）。
  // 待ち時間（busy_timeout）は接続ごとの設定なので、libsql が開くどの接続にも当たる timeout で渡す
  // （接続が捨てられて開き直されても効く）。書く接続はこの 1 本だけ。重い読み取りは、別のスレッドで書けない
  // 接続を開いて流す（heavy-read.ts。書かないので、上の SQLITE_BUSY_SNAPSHOT には当たらない）
  const client = createClient({ url, concurrency: 1, timeout: BUSY_TIMEOUT_MS });
  try {
    await client.execute("PRAGMA foreign_keys = ON");
    if (url !== ":memory:") await client.execute("PRAGMA journal_mode = WAL");
    const db = drizzle(client, { schema });
    // マイグレーションを当てる（決定の 5）。migrations/ の SQL を使う。当てたものは
    // __drizzle_migrations に記録され、2 回目からは新しいものだけを当てる
    await migrate(db, { migrationsFolder: options.migrationsFolder });
    return { db, close: () => client.close() };
  } catch (error) {
    client.close();
    throw error;
  }
}
