import { type SQL, sql } from "drizzle-orm";
import { type Database, getRow } from ".";
import { DB_NOW_MS } from "./clock";

/** 解析の版 */
export interface AnalysisRevisions {
  candidateRevision: number;
  embeddingRevision: number;
}

/** 遡及の位置。null なら先頭から */
export interface BackfillCursor {
  createdAt: number;
  id: string;
}

export interface BackfillState extends AnalysisRevisions {
  cursor: BackfillCursor | null;
  /** 先頭に戻すたびに増やす番号 */
  epoch: number;
  finished: boolean;
  completedEmbeddingRevision: number | null;
  completedAt: number | null;
}

/** 取り込んでから、本文の記録がなくても解析を待つ記事にするまでの時間（決定の 2） */
export const ANALYSIS_WAIT_MS = 60 * 60 * 1000;

/**
 * 解析を待つ記事の条件（docs/decisions/article-analysis.md の 2）。今の版の解析がなく、本文を抜いた・抜けな
 * かった記録がある、ページから抜かない（http ／ https の URL がない、Discord の投稿）、取り込んでから
 * 1 時間たった、のどれか。a は articles
 */
function waitingForAnalysis(revisions: AnalysisRevisions): SQL {
  return sql`not exists (
      select 1 from article_analyses x where x.article_id = a.id
        and x.candidate_revision >= ${revisions.candidateRevision}
        and x.embedding_revision >= ${revisions.embeddingRevision}
    ) and (
      exists (select 1 from page_contents p where p.article_id = a.id)
      or a.url is null
      or exists (select 1 from feeds f where f.id = a.feed_id and f.discord_cursor is not null)
      or a.created_at <= ${DB_NOW_MS} - ${ANALYSIS_WAIT_MS}
    )`;
}

export async function readBackfill(db: Database): Promise<BackfillState | undefined> {
  const row = await getRow<{
    cursorCreatedAt: number | null;
    cursorId: string | null;
    candidateRevision: number;
    embeddingRevision: number;
    finished: number;
    epoch: number;
    completedEmbeddingRevision: number | null;
    completedAt: number | null;
  }>(
    db,
    sql`select cursor_created_at as cursorCreatedAt, cursor_id as cursorId,
      candidate_revision as candidateRevision, embedding_revision as embeddingRevision, finished, epoch,
      completed_embedding_revision as completedEmbeddingRevision, completed_at as completedAt
    from article_analysis_backfill where id = 1`,
  );
  if (!row) return undefined;
  return {
    cursor:
      row.cursorCreatedAt === null || row.cursorId === null
        ? null
        : { createdAt: row.cursorCreatedAt, id: row.cursorId },
    candidateRevision: row.candidateRevision,
    embeddingRevision: row.embeddingRevision,
    finished: row.finished !== 0,
    epoch: row.epoch,
    completedEmbeddingRevision: row.completedEmbeddingRevision,
    completedAt: row.completedAt,
  };
}

/**
 * 遡及の位置の行を用意する。行がなければ先頭から作り、対象の版が今の版と違えば（版を上げた）、対象の版を
 * 書き換えて先頭に戻す（決定の 2）。同じ文で確かめるので、重なっても同じ結果になる
 */
export async function prepareBackfill(db: Database, revisions: AnalysisRevisions): Promise<void> {
  await db.run(sql`
    insert into article_analysis_backfill (id, cursor_created_at, cursor_id, candidate_revision,
      embedding_revision, finished)
    values (1, null, null, ${revisions.candidateRevision}, ${revisions.embeddingRevision}, 0)
    on conflict (id) do update set cursor_created_at = null, cursor_id = null, finished = 0,
      epoch = article_analysis_backfill.epoch + 1,
      candidate_revision = excluded.candidate_revision, embedding_revision = excluded.embedding_revision
    where article_analysis_backfill.candidate_revision != excluded.candidate_revision
      or article_analysis_backfill.embedding_revision != excluded.embedding_revision
  `);
}

/** 遡及の位置を先頭に戻す（1 日 1 回の片付け。決定の 2）。対象の版は変えない */
export async function rewindBackfill(db: Database): Promise<void> {
  await db.run(sql`
    update article_analysis_backfill set cursor_created_at = null, cursor_id = null, finished = 0,
      epoch = epoch + 1
    where id = 1
  `);
}

/**
 * 位置のあとの記事を、取り込みの時刻と ID の新しい順に limit 件まで返す。解析を待つ記事かどうかも返す
 */
export function findBackfillArticles(
  db: Database,
  input: { cursor: BackfillCursor | null; revisions: AnalysisRevisions; limit: number },
): Promise<{ id: string; createdAt: number; waiting: number }[]> {
  const after =
    input.cursor === null
      ? sql`1`
      : sql`(a.created_at, a.id) < (${input.cursor.createdAt}, ${input.cursor.id})`;
  return db.all(sql`
    select a.id, a.created_at as createdAt, ${waitingForAnalysis(input.revisions)} as waiting
    from articles a
    where ${after}
    order by a.created_at desc, a.id desc
    limit ${input.limit}
  `);
}

/**
 * 遡及の位置を書く。位置、先頭に戻した番号、対象の版が、読んだときのままであることを同じ文で確かめる
 * （先頭に戻したのを、古い仕事が上書きしない。決定の 2）。最後までたどり終えたら finished にし、その埋め込みの版で初めて
 * たどり終えたときだけ、埋め込みの版と時刻を記録する（1 日 1 回の遡及の終わりでは書き換えない）。
 * 書いたら true
 */
export async function advanceBackfill(
  db: Database,
  input: {
    read: Pick<BackfillState, "cursor" | "epoch" | "candidateRevision" | "embeddingRevision">;
    cursor: BackfillCursor | null;
    finished: boolean;
  },
): Promise<boolean> {
  const { read } = input;
  const same =
    read.cursor === null
      ? sql`cursor_created_at is null and cursor_id is null`
      : sql`cursor_created_at = ${read.cursor.createdAt} and cursor_id = ${read.cursor.id}`;
  const firstCompletion = sql`${input.finished ? 1 : 0} = 1
    and completed_embedding_revision is not embedding_revision`;
  const row = await getRow<{ id: number }>(
    db,
    sql`
    update article_analysis_backfill set
      cursor_created_at = ${input.cursor?.createdAt ?? null},
      cursor_id = ${input.cursor?.id ?? null},
      finished = ${input.finished ? 1 : 0},
      completed_at = case when ${firstCompletion} then ${DB_NOW_MS} else completed_at end,
      completed_embedding_revision = case when ${firstCompletion} then embedding_revision
        else completed_embedding_revision end
    where id = 1 and finished = 0 and epoch = ${read.epoch} and ${same}
      and candidate_revision = ${read.candidateRevision}
      and embedding_revision = ${read.embeddingRevision}
    returning id
  `,
  );
  return row !== undefined;
}

/**
 * 拾い直し（決定の 2）：取り込んでから 1 日以内の記事のうち、解析を待つ記事を、取り込みの時刻の新しい順に
 * limit 件まで返す。記事の取り込みの時刻の索引で引く
 */
export async function findRepickArticles(
  db: Database,
  input: { since: number; revisions: AnalysisRevisions; limit: number },
): Promise<string[]> {
  const rows = await db.all<{ id: string }>(sql`
    select a.id from articles a
    where a.created_at >= ${input.since} and ${waitingForAnalysis(input.revisions)}
    order by a.created_at desc, a.id desc
    limit ${input.limit}
  `);
  return rows.map((row) => row.id);
}
