/**
 * DB（docs/decisions/container.md の 5）。SQLite のファイルを libsql で開く。
 */
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import type { Database } from "../../db";
import * as schema from "../../db/schema";

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
  // 接続は 1 本にする。libsql のクライアントは既定で接続を最大 20 本持ち、重なった呼び出しに
  // 別々の接続を使う。そうすると、下の PRAGMA（busy_timeout は接続ごと）が最初の 1 本にしか
  // 効かず、書き込みが重なると待たずに SQLITE_BUSY になる。WAL では、ほかの接続が先に書くと
  // SQLITE_BUSY_SNAPSHOT にもなる（busy_timeout では防げない。sendo-feed/sendo#215）。
  // 書くのは 1 つのプロセスだけで、文は JavaScript の流れの中で 1 つずつ同期して動くので、
  // 接続を増やしても速くはならない
  const client = createClient({ url, concurrency: 1 });
  try {
    await client.execute("PRAGMA foreign_keys = ON");
    await client.execute("PRAGMA busy_timeout = 5000");
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
