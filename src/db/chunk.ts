import { getTableColumns, type Table } from "drizzle-orm";

/**
 * D1 は 1 つの文に渡せる変数が 100 個まで（https://developers.cloudflare.com/d1/platform/limits/）。
 * まとめて書き込むときや IN 句に並べるときは、これを超えないように分ける。
 */
export const MAX_BOUND_PARAMETERS = 100;

/**
 * 1 つの文に収まる大きさに分ける。
 *
 * @param table 複数行をまとめて INSERT するときの表。全部の列が変数になると見積もって、
 *   1 行あたりの列の数で割る。null なら IN 句などで 1 件 1 変数として数える
 */
export function chunked<T>(items: readonly T[], table: Table | null): T[][] {
  const perItem = table === null ? 1 : Object.keys(getTableColumns(table)).length;
  // 条件などに使う分として、いくつか残しておく
  const size = Math.max(1, Math.floor((MAX_BOUND_PARAMETERS - 2) / perItem));
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}
