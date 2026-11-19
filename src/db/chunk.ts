import { getTableColumns, type Table } from "drizzle-orm";

/**
 * 1 つの文に渡す変数の数の上限。SQLite の上限（32766）よりずっと小さく抑え、1 つの文を小さく保つ
 * （1 つの文で長く書き込みの錠を持たない）。まとめて書き込むときや IN 句に並べるときは、
 * これを超えないように分ける。
 */
export const MAX_BOUND_PARAMETERS = 100;

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
 * @param unboundColumns SQL のリテラルで渡し、変数を使わない列の数
 */
export function chunked<T>(items: readonly T[], table: Table | null, unboundColumns = 0): T[][] {
  const perItem = table === null ? 1 : Object.keys(getTableColumns(table)).length - unboundColumns;
  const size = Math.max(1, Math.floor((MAX_BOUND_PARAMETERS - RESERVED_PARAMETERS) / perItem));
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}
