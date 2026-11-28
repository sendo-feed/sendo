import { sql } from "drizzle-orm";
import { type Database, getRow } from ".";
import { DB_NOW_MS } from "./clock";
import { tagMatchKey } from "./tags";

/*
 * タグの候補の一覧と却下（docs/decisions/tags.md の 1〜3）。
 */

/** 候補の一覧で数える範囲（受信箱に入った時刻と公開日時のどちらも、DB の時計でこの長さ以内） */
export const CANDIDATE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
/** 候補の一覧に返す数 */
export const MAX_CANDIDATE_ITEMS = 100;
/** フィードの定型の語を見分けるのは、そのフィードの範囲の解析済みの記事がこの数以上のときだけ */
export const BOILERPLATE_MIN_ARTICLES = 10;
/** 1 人が却下できる語の数 */
export const MAX_TAG_REJECTIONS = 1_000;
/** 却下するときの鍵の長さ（正規化したあとのコードポイント。候補の長さと同じ） */
const MIN_REJECT_KEY_LENGTH = 2;
const MAX_REJECT_KEY_LENGTH = 40;
/** 戻すときの鍵の長さ（受けたままの形のコードポイント） */
const MAX_RESTORE_KEY_LENGTH = 200;

export type TagCandidate = { key: string; label: string; count: number };

/**
 * 候補の一覧（docs/decisions/tags.md の 1、2）。その人の受信箱の、受信箱に入った時刻と公開日時のどちらも
 * 30 日以内の記事について、鍵ごとに記事の数を数え、多い順（同じ数なら鍵のコードポイントの順）に 100 件まで
 * 返す。数えるのは解析の行と世代が同じ候補の行だけ。同じフィードの範囲の解析済みの記事の 50% 以上（ちょうど
 * を含む）に記事の文字の候補として出る鍵は、そのフィードの記事からは数えない（解析済みの記事が 10 件以上の
 * フィードだけ）。有効なタグの照合用の名前と、却下した鍵は外す。見出しは、数えた行の表記のうちいちばん
 * 多いもの（同じ数なら表記のコードポイントの順で先のもの）。pending は、範囲の記事のうち今の候補の版の
 * 解析がない記事の数
 */
export async function listTagCandidates(
  db: Database,
  input: { userId: string; candidateRevision: number },
): Promise<{ items: TagCandidate[]; pending: number }> {
  const { userId } = input;
  const since = sql`(${DB_NOW_MS} - ${CANDIDATE_WINDOW_MS})`;
  // 候補の行を「フィード・鍵・出どころ」ごとに 1 回だけ数え、定型の語の判定と鍵ごとの合計は、まとめた表の
  // 上で行う（候補の行は記事あたり数十行になり、行のまま何度も集計すると遅いため）。見出しの表記は、上位の
  // 鍵の行だけで数える
  const items = await db.all<TagCandidate>(sql`
    with analyzed as materialized (
      select ua.article_id, ua.feed_id, x.candidate_generation as generation
      from user_articles ua join article_analyses x on x.article_id = ua.article_id
      where ua.user_id = ${userId} and ua.published_at >= ${since} and ua.created_at >= ${since}
    ),
    candidate_rows as materialized (
      select a.feed_id, c.key, c.source, c.surface
      from analyzed a
      join article_candidates c on c.article_id = a.article_id and c.generation = a.generation
    ),
    feed_sizes as materialized (
      select feed_id, count(*) as n from analyzed group by feed_id
    ),
    per_feed as materialized (
      select feed_id, key, source, count(*) as n from candidate_rows group by feed_id, key, source
    ),
    -- フィードの定型の語：記事の文字の候補で、そのフィードの解析済みの記事が 10 件以上あり、その 50% 以上
    -- （ちょうどを含む）に出る鍵。そのフィードの記事からは数えない
    kept as materialized (
      select p.key, p.n from per_feed p join feed_sizes s on s.feed_id = p.feed_id
      where not (p.source = 'text' and s.n >= ${BOILERPLATE_MIN_ARTICLES} and p.n * 2 >= s.n)
    ),
    top as materialized (
      select key, sum(n) as n from kept
      where not exists (
          select 1 from tags t
          where t.user_id = ${userId} and t.deleted_at is null and t.match_key = kept.key
        )
        and not exists (
          select 1 from tag_rejections j where j.user_id = ${userId} and j.key = kept.key
        )
      group by key
      order by n desc, key limit ${MAX_CANDIDATE_ITEMS}
    ),
    labels as (
      select r.key, r.surface,
        row_number() over (partition by r.key order by count(*) desc, r.surface) as rank
      from candidate_rows r
      join top t on t.key = r.key
      join feed_sizes s on s.feed_id = r.feed_id
      where not (r.source = 'text' and s.n >= ${BOILERPLATE_MIN_ARTICLES} and (
        select p.n from per_feed p
        where p.feed_id = r.feed_id and p.key = r.key and p.source = 'text'
      ) * 2 >= s.n)
      group by r.key, r.surface
    )
    select t.key, t.n as count, l.surface as label
    from top t join labels l on l.key = t.key and l.rank = 1
    order by t.n desc, t.key
  `);
  const pending = await getRow<{ n: number }>(
    db,
    sql`select count(*) as n from user_articles ua
    where ua.user_id = ${userId} and ua.published_at >= ${since} and ua.created_at >= ${since}
      and not exists (
        select 1 from article_analyses x
        where x.article_id = ua.article_id and x.candidate_revision >= ${input.candidateRevision}
      )`,
  );
  return { items, pending: pending?.n ?? 0 };
}

const CONTROL_OR_LONE_SURROGATE =
  /[\p{Cc}]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

/**
 * 却下する鍵を、まとめの鍵の作り方で正規化し直して確かめる（docs/decisions/tags.md の 3）。2〜40 コード
 * ポイントで、制御文字か対になっていないサロゲートを含まないこと。合わなければ null
 */
export function parseRejectKey(key: string): string | null {
  if (CONTROL_OR_LONE_SURROGATE.test(key)) return null;
  const normalized = tagMatchKey(key);
  const length = [...normalized].length;
  if (length < MIN_REJECT_KEY_LENGTH || length > MAX_REJECT_KEY_LENGTH) return null;
  return normalized;
}

/**
 * 戻す鍵を確かめる（docs/decisions/tags.md の 3）。2〜40 の決まりは当てず、受けたままの形で 200 コード
 * ポイントまで。制御文字か対になっていないサロゲートを含めば null
 */
export function parseRestoreKey(key: string): string | null {
  if (CONTROL_OR_LONE_SURROGATE.test(key)) return null;
  if ([...key].length > MAX_RESTORE_KEY_LENGTH) return null;
  return key;
}

/**
 * 却下する。却下済みの語は上限より先に見て成功にし（created: false）、上限は同じ文の中で数える。上限ちょうど
 * （1,000 語目）は受ける。入らなければ理由を読み直し、どの理由にも当たらなければ（読み直す前に同じ語が戻された）
 * 1 回だけ流し直す（タグの作成と同じ形）
 */
export async function rejectTagCandidate(
  db: Database,
  input: { userId: string; key: string },
): Promise<{ created: boolean } | "tag_rejection_limit_reached"> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const inserted = await getRow<{ key: string }>(
      db,
      sql`insert into tag_rejections (user_id, key, rejected_at)
      select ${input.userId}, ${input.key}, ${DB_NOW_MS}
      where (select count(*) from tag_rejections where user_id = ${input.userId}) < ${MAX_TAG_REJECTIONS}
      on conflict do nothing
      returning key`,
    );
    if (inserted) return { created: true };
    const found = await getRow<{ existing: number; full: number }>(
      db,
      sql`select
        exists (select 1 from tag_rejections where user_id = ${input.userId} and key = ${input.key})
          as existing,
        (select count(*) from tag_rejections where user_id = ${input.userId}) >= ${MAX_TAG_REJECTIONS}
          as full`,
    );
    if (found?.existing) return { created: false };
    if (found?.full) return "tag_rejection_limit_reached";
  }
  throw new Error("tag rejection was neither created nor found");
}

/**
 * 却下を戻す。受けた鍵と保存した鍵をそのまま照らし、正規化し直した形でも照らして消す。ない語を戻しても成功
 * にする（restored: false）
 */
export async function restoreTagCandidate(
  db: Database,
  input: { userId: string; key: string },
): Promise<{ restored: boolean }> {
  const rows = await db.all<{ key: string }>(sql`
    delete from tag_rejections
    where user_id = ${input.userId} and key in (${input.key}, ${tagMatchKey(input.key)})
    returning key
  `);
  return { restored: rows.length > 0 };
}

/** 却下した語を新しい順に返す */
export function listTagRejections(
  db: Database,
  userId: string,
): Promise<{ key: string; rejectedAt: number }[]> {
  return db.all(sql`
    select key, rejected_at as "rejectedAt" from tag_rejections
    where user_id = ${userId}
    order by rejected_at desc, key
  `);
}
