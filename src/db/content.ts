import { sql } from "drizzle-orm";
import type { Database } from ".";
import { DB_NOW_MS } from "./clock";

/*
 * 記事の本文の、置き場の名前の書き留め（docs/decisions/content.md の 4）。
 *
 * 本文は置き場（R2）に、記事の行は D1 にあり、1 つの文でまとめて書けない。そこで、置く前に名前を
 * 書き留め、記事の行に入ったら消す。行に入らなかった名前（その記事がもうあった、途中で落ちた）と、
 * 記事の行が消えたときにトリガーが書き留めた名前は、1 日 1 回の片付けが本文を消す。
 *
 * 名前は 1 つの変数（JSON の配列）で渡す。名前の数だけ変数を並べると、D1 の「1 文あたり
 * 100 個まで」に当たる
 */

/** 書き留めを片付けるまで待つ時間。取得のジョブが動いている間のものを消さないため */
export const CONTENT_NOTE_GRACE_MS = 60 * 60 * 1000;

/** フィードの記事のうち、すでにある guid を返す（新しい記事の本文だけを置くために読む） */
export async function findExistingGuids(
  db: Database,
  input: { feedId: string; guids: readonly string[] },
): Promise<Set<string>> {
  const rows = await db.all<{ guid: string }>(sql`
    select guid from articles
    where feed_id = ${input.feedId}
      and guid in (select value from json_each(${JSON.stringify(input.guids)}))
  `);
  return new Set(rows.map((row) => row.guid));
}

/** これから置く本文の名前を書き留める。本文を置く前に呼ぶ */
export async function noteContentKeys(db: Database, keys: readonly string[]): Promise<void> {
  if (keys.length === 0) return;
  await db.run(sql`
    insert into content_notes (key, created_at)
    select value, ${DB_NOW_MS} from json_each(${JSON.stringify(keys)})
    where true
    on conflict (key) do nothing
  `);
}

/**
 * 記事の行に入っている名前の書き留めを消す。行に入っているかは、消す文の中で確かめる。
 * 入っていない名前は残り、片付けが本文を消す。
 *
 * 取り込みで記事の行を入れたあとと、片付けが「行に入っている」と読んだ名前を消すときに使う。
 * 片付けでは、読んだあとで記事が消えていることがある（トリガーは、書き留めがもうあると何も
 * 足さない）ので、読んだ結果ではなく、この文で確かめる
 */
export async function clearUsedContentNotes(db: Database, keys: readonly string[]): Promise<void> {
  if (keys.length === 0) return;
  await db.run(sql`
    delete from content_notes
    where key in (select value from json_each(${JSON.stringify(keys)}))
      and exists (select 1 from articles where articles.content_key = content_notes.key)
  `);
}

/**
 * before より前の書き留めを、古い順に読む。used は、その名前が記事の行に入っているか。
 *
 * 入っていない名前は、あとから入ることもない（名前は置くたびに乱数で決め、行に入れるのは
 * それを書き留めた実行だけ。その実行は、before より前に終わっている）
 */
export async function readOldContentNotes(
  db: Database,
  input: { before: Date; limit: number },
): Promise<{ key: string; used: boolean }[]> {
  const rows = await db.all<{ key: string; used: number }>(sql`
    select key,
      exists (select 1 from articles where articles.content_key = content_notes.key) as used
    from content_notes
    where created_at < ${input.before.getTime()}
    order by created_at
    limit ${input.limit}
  `);
  return rows.map((row) => ({ key: row.key, used: row.used !== 0 }));
}

/** 書き留めを消す。行に入っていない名前の本文を、置き場から消したあとで呼ぶ */
export async function deleteContentNotes(db: Database, keys: readonly string[]): Promise<void> {
  if (keys.length === 0) return;
  await db.run(sql`
    delete from content_notes
    where key in (select value from json_each(${JSON.stringify(keys)}))
  `);
}
