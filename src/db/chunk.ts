import { getTableColumns, type Table } from "drizzle-orm";

/**
 * D1 は 1 つの文に渡せる変数が 100 個まで（https://developers.cloudflare.com/d1/platform/limits/）。
 * まとめて書き込むときや IN 句に並べるときは、これを超えないように分ける。
 */
export const MAX_BOUND_PARAMETERS = 100;

/**
 * D1 は Worker の 1 回の実行で 50 クエリまで（無料プラン。有料は 1,000）。
 * 1 回の実行（API の 1 リクエスト、キューの 1 件、定期実行の 1 回）で使うクエリは、
 * 余裕を持ってこの数に収める。テストで、最悪の場合の数を数えて確かめている。
 */
export const QUERY_BUDGET = 45;

/**
 * chunked で分けたもの以外に、1 つの文で使ってよい変数の数（条件のユーザーの ID、
 * フォルダを確かめる副問い合わせ、日時など）。chunked で分けて使う文は、ほかの変数を
 * この数までに収める。
 */
export const RESERVED_PARAMETERS = 10;

/**
 * 1 つの文に収まる大きさに分ける。
 *
 * @param table 複数行をまとめて INSERT するときの表。全部の列が変数になると見積もって、
 *   1 行あたりの列の数で割る。null なら IN 句などで 1 件 1 変数として数える
 */
export function chunked<T>(items: readonly T[], table: Table | null): T[][] {
  const perItem = table === null ? 1 : Object.keys(getTableColumns(table)).length;
  const size = Math.max(1, Math.floor((MAX_BOUND_PARAMETERS - RESERVED_PARAMETERS) / perItem));
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}
