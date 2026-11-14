import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import type * as schema from "./schema";

/**
 * アプリから見た DB。
 *
 * D1 に固有の型（DrizzleD1Database）ではなく、SQLite の非同期ドライバに共通の型で受け取る。
 * こうしておけば、移植するときに libsql などのドライバに差し替えられる。
 *
 * D1 は対話的なトランザクションが使えないので、トランザクションに頼らず、
 * 何度実行しても同じ結果になる（冪等な）書き込みで組み立てる。
 */
export type Database = BaseSQLiteDatabase<"async", unknown, typeof schema>;
