import { getTableName, type SQL, sql } from "drizzle-orm";
import type { Database } from ".";
import { type folders, seqFloors, type subscriptions, type userArticles } from "./schema";

/** 変更番号を持つ表（docs/decisions/sync.md） */
export type SeqTable = typeof folders | typeof subscriptions | typeof userArticles;

/**
 * 次の変更番号を返す SQL の式。行を作る ／ 変える文の中で、seq の値として使う。
 *
 * 「その表の最大」と「記録した下限」の大きいほうに 1 を足す。D1 は文を 1 つずつ順に処理する
 * ので、同じ文の中で振れば、番号の順が書き込みの順と一致する。同じ文で変えた行は、同じ番号に
 * なってよい。
 */
export function nextSeq(table: SeqTable): SQL<number> {
  // 表の名前はコードで決まる定数なので、変数にせず SQL に直接書く。変数にすると、複数行を
  // まとめて入れるときに 1 行ごとに変数が増え、D1 の「1 文あたり 100 個まで」の計算が狂う
  const name = sql.raw(`'${getTableName(table)}'`);
  return sql<number>`(select max(
    coalesce((select max(${sql.identifier("seq")}) from ${table}), 0),
    coalesce((select ${seqFloors.floor} from ${seqFloors} where ${seqFloors.tableName} = ${name}), 0)
  ) + 1)`;
}

/**
 * 行を物理的に消す前に呼ぶ。その表でそれまでに振った最大の番号を、下限として記録する。
 * 最大の番号の行を消しても、その番号がもう一度振られないようにする。
 */
export async function recordSeqFloor(db: Database, table: SeqTable): Promise<void> {
  const name = getTableName(table);
  await db.run(sql`
    insert into ${seqFloors} (${sql.identifier("table_name")}, ${sql.identifier("floor")})
    values (${name}, coalesce((select max(${sql.identifier("seq")}) from ${table}), 0))
    on conflict (${sql.identifier("table_name")})
    do update set ${sql.identifier("floor")} = max(${sql.identifier("floor")}, excluded.${sql.identifier("floor")})
  `);
}
