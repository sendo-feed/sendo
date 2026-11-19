import type { SQL } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import type * as schema from "./schema";

/**
 * アプリから見た DB。
 *
 * libsql に固有の型ではなく、SQLite の非同期ドライバに共通の型で受け取る。
 *
 * トランザクションに頼らず、何度実行しても同じ結果になる（冪等な）書き込みで組み立てる。
 * 途中で落ちても、仕事をやり直せば正しい状態に戻る（docs/decisions/tech-stack.md）。
 */
export type Database = BaseSQLiteDatabase<"async", unknown, typeof schema>;

/**
 * 生の SQL で 1 行を読む。行がなければ undefined。
 *
 * drizzle の libsql の `db.get(sql)` は、行が返らないと例外を投げる（行を写すところで、ない行を
 * 読もうとする）。update ... returning の「確かめて書けなかった」や、行のない select に使う
 */
export async function getRow<T>(db: Database, query: SQL): Promise<T | undefined> {
  const [row] = await db.all<T>(query);
  return row;
}
