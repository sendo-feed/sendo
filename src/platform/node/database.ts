/**
 * コンテナ版の DB（docs/decisions/container.md の 5）。SQLite のファイルを libsql で開く。
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
 * D1 にそろえて、外部キーを効かせる（D1 は既定で効いている）。書き込みは 1 つのプロセスからだけなので
 * （決定の 7）、WAL にして、読むのが書くのを待たないようにする
 */
export async function openDatabase(
  url: string,
  options: { migrationsFolder: string },
): Promise<OpenedDatabase> {
  const client = createClient({ url });
  try {
    await client.execute("PRAGMA foreign_keys = ON");
    await client.execute("PRAGMA busy_timeout = 5000");
    if (url !== ":memory:") await client.execute("PRAGMA journal_mode = WAL");
    const db = drizzle(client, { schema });
    // マイグレーションを当てる（決定の 5）。Cloudflare 版と同じ migrations/ を使う。当てたものは
    // __drizzle_migrations に記録され、2 回目からは新しいものだけを当てる
    await migrate(db, { migrationsFolder: options.migrationsFolder });
    return { db, close: () => client.close() };
  } catch (error) {
    client.close();
    throw error;
  }
}
