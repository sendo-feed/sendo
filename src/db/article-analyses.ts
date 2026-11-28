import { sql } from "drizzle-orm";
import type { AnalysisCandidate } from "../platform";
import { type Database, getRow } from ".";
import { DB_NOW_MS } from "./clock";
import type { ANALYSIS_STATUSES } from "./schema";

/** 解析の状態。済み ／ 入力が空 ／ 失敗（docs/decisions/article-analysis.md の 5） */
export type AnalysisStatus = (typeof ANALYSIS_STATUSES)[number];

/**
 * 書いたあとの使用量の上限（上限に対する割合）。新しい記事の連鎖の解析は、片付けの始まる 90% 以上に
 * なるなら書かない（docs/decisions/article-analysis.md の 4）
 */
export const CHAIN_STORAGE_SHARE = 0.9;

/** 世代の合わない候補の行を消すまでの時間（docs/decisions/article-analysis.md の 5） */
export const STALE_CANDIDATE_GRACE_MS = 24 * 60 * 60 * 1000;

const encoder = new TextEncoder();

/** 解析の行の容量の見積もり。容量のトリガー（0077）と合わせる */
export function analysisRowBytes(embedding: Uint8Array | null): number {
  return 256 + (embedding?.byteLength ?? 0);
}

/** 候補の行の容量の見積もり。容量のトリガー（0077）と合わせる */
export function candidateRowBytes(candidate: AnalysisCandidate): number {
  return 128 + encoder.encode(candidate.key).length + encoder.encode(candidate.surface).length;
}

/** 候補の行をまとめた容量の見積もり */
export function candidatesBytes(candidates: readonly AnalysisCandidate[]): number {
  return candidates.reduce((sum, candidate) => sum + candidateRowBytes(candidate), 0);
}

/** 書く文の中で、書いたあとの使用量が上限の割合に収まるかを確かめる */
function fits(bytes: number, share: number) {
  return sql`(select bytes + ${bytes} < limit_bytes * ${share} from storage_usage where id = 1)`;
}

export interface AnalysisVersions {
  candidateRevision: number | null;
  embeddingRevision: number | null;
}

/** 解析の行の版。行がなければ undefined */
export function getAnalysisVersions(
  db: Database,
  articleId: string,
): Promise<AnalysisVersions | undefined> {
  return getRow<AnalysisVersions>(
    db,
    sql`select candidate_revision as candidateRevision, embedding_revision as embeddingRevision
    from article_analyses where article_id = ${articleId}`,
  );
}

export interface AnalysisSource {
  feedId: string;
  title: string | null;
  summary: string | null;
  contentKey: string | null;
  /** 抜いた本文。抜けていなければ null */
  pageHtml: string | null;
}

/** 解析の入力の材料。記事がなければ undefined */
export function readAnalysisSource(
  db: Database,
  articleId: string,
): Promise<AnalysisSource | undefined> {
  return getRow<AnalysisSource>(
    db,
    sql`select a.feed_id as feedId, a.title, a.summary, a.content_key as contentKey,
      case when p.status = 'extracted' then p.html end as pageHtml
    from articles a left join page_contents p on p.article_id = a.id
    where a.id = ${articleId}`,
  );
}

/**
 * 同じフィードのほかの記事の解析の行（版と状態によらない）に、同じ要約のハッシュがあるか
 * （docs/decisions/article-analysis.md の 8）
 */
export async function hasSameSummary(
  db: Database,
  input: { articleId: string; feedId: string; summaryHash: string },
): Promise<boolean> {
  const row = await getRow<{ found: number }>(
    db,
    sql`select 1 as found from article_analyses
    where feed_id = ${input.feedId} and summary_hash = ${input.summaryHash}
      and article_id != ${input.articleId}
    limit 1`,
  );
  return row !== undefined;
}

/**
 * 候補の行を、新しい世代で 1 つの文でまとめて入れる（docs/decisions/article-analysis.md の 5）。
 * 記事があることと、書いたあとの使用量（このあとに書く解析の行の分 reservedBytes を含める）が
 * 上限の割合に収まることを、同じ文で確かめる。入れた行の数を返す
 */
export async function insertCandidates(
  db: Database,
  input: {
    articleId: string;
    generation: string;
    candidates: readonly AnalysisCandidate[];
    reservedBytes: number;
    share: number;
  },
): Promise<number> {
  if (input.candidates.length === 0) return 0;
  const bytes = input.reservedBytes + candidatesBytes(input.candidates);
  const rows = await db.all<{ key: string }>(sql`
    insert into article_candidates (article_id, generation, key, surface, source, created_at)
    select ${input.articleId}, ${input.generation}, json_extract(value, '$.key'),
      json_extract(value, '$.surface'), json_extract(value, '$.source'), ${DB_NOW_MS}
    from json_each(${JSON.stringify(input.candidates)})
    where exists (select 1 from articles where id = ${input.articleId}) and ${fits(bytes, input.share)}
    on conflict do nothing
    returning key
  `);
  return rows.length;
}

export interface AnalysisRecord {
  articleId: string;
  summaryHash: string | null;
  /** 候補を作ったときだけ */
  candidates?: { revision: number; status: AnalysisStatus; generation: string | null };
  /** 埋め込みを作ったときだけ */
  embedding?: { revision: number; status: AnalysisStatus; vector: Uint8Array | null };
  share: number;
}

/**
 * 解析の行を書く（docs/decisions/article-analysis.md の 5）。候補と埋め込みの版を別々に比べ、今の行より
 * 新しい版の側の列だけを書く。同じ版は上書きしない。記事があることと、書いたあとの使用量を同じ文で
 * 確かめる。書いたら true
 */
export async function recordAnalysis(db: Database, input: AnalysisRecord): Promise<boolean> {
  const c = input.candidates;
  const e = input.embedding;
  const vector = e?.vector ?? null;
  // 今の行より新しい版か。求めなかった側（版が null）は書かない
  const newerCandidates = sql`excluded.candidate_revision is not null and (
    article_analyses.candidate_revision is null
    or article_analyses.candidate_revision < excluded.candidate_revision)`;
  const newerEmbedding = sql`excluded.embedding_revision is not null and (
    article_analyses.embedding_revision is null
    or article_analyses.embedding_revision < excluded.embedding_revision)`;
  const row = await getRow<{ articleId: string }>(
    db,
    sql`
    insert into article_analyses (article_id, feed_id, summary_hash, candidate_revision, candidate_status,
      candidate_generation, embedding_revision, embedding_status, embedding, analyzed_at)
    select a.id, a.feed_id, ${input.summaryHash}, ${c?.revision ?? null}, ${c?.status ?? null},
      ${c?.generation ?? null}, ${e?.revision ?? null}, ${e?.status ?? null}, ${vector}, ${DB_NOW_MS}
    from articles a
    where a.id = ${input.articleId} and ${fits(analysisRowBytes(vector), input.share)}
    on conflict (article_id) do update set
      summary_hash = excluded.summary_hash,
      candidate_revision = case when ${newerCandidates} then excluded.candidate_revision
        else article_analyses.candidate_revision end,
      candidate_status = case when ${newerCandidates} then excluded.candidate_status
        else article_analyses.candidate_status end,
      candidate_generation = case when ${newerCandidates} then excluded.candidate_generation
        else article_analyses.candidate_generation end,
      embedding_revision = case when ${newerEmbedding} then excluded.embedding_revision
        else article_analyses.embedding_revision end,
      embedding_status = case when ${newerEmbedding} then excluded.embedding_status
        else article_analyses.embedding_status end,
      embedding = case when ${newerEmbedding} then excluded.embedding
        else article_analyses.embedding end,
      analyzed_at = excluded.analyzed_at
    where (${newerCandidates}) or (${newerEmbedding})
    returning article_id as articleId
  `,
  );
  return row !== undefined;
}

/**
 * 解析の行の世代と合わず、作ってから before より前の候補の行を消す（docs/decisions/article-analysis.md
 * の 5）。実行中の解析の行は、作ってから 1 日たたないので消さない。消した行の数を返す
 */
export async function collectStaleCandidates(
  db: Database,
  input: { before: Date; limit: number },
): Promise<number> {
  const rows = await db.all<{ key: string }>(sql`
    delete from article_candidates where rowid in (
      select c.rowid from article_candidates c
      where c.created_at < ${input.before.getTime()} and not exists (
        select 1 from article_analyses x
        where x.article_id = c.article_id and x.candidate_generation = c.generation
      )
      limit ${input.limit}
    )
    returning key
  `);
  return rows.length;
}
