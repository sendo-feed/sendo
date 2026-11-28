import { type SQL, sql } from "drizzle-orm";
import { type Database, getRow } from ".";
import { CHAIN_STORAGE_SHARE } from "./article-analyses";
import { DB_NOW_MS } from "./clock";
import { articleTags } from "./schema";
import { nextSeq } from "./seq";

/*
 * 自動のタグ付けの判定（docs/decisions/auto-tagging.md の 1、2、4、6、7）。人ごとのタグの版と判定し直しの
 * 位置、タグのベクトルと統計、自動の書き込み。
 */

/**
 * 判定の版（4）。係数、Rocchio の重み、統計を求める件数、名前と説明の入力の形を変えたら上げる
 * （記事の言語判定の pipeline_revision と同じ考え）
 */
export const JUDGE_REVISION = 1;
/** 正規化した類似度がこの値以上なら付ける（2） */
export const TAG_SCORE_THRESHOLD = 1.8;
/** Rocchio の重み（1）。名前と説明の埋め込み 1 に対して */
export const POSITIVE_WEIGHT = 0.5;
export const NEGATIVE_WEIGHT = 0.25;
/** 統計を求める受信箱の記事の数（2） */
export const STATS_SAMPLE_SIZE = 2_000;
/** 統計がこれより少ない記事から求めたものなら、自動で付けない（2） */
export const STATS_MIN_COUNT = 100;
/** 標準偏差がこれより小さければ、自動で付けない（2） */
export const STATS_MIN_STD_DEV = 0.001;
/** 判定し直しは、版を上げてからこの長さ待って始める（6） */
export const REJUDGE_DELAY_MS = 60 * 1000;
/** 1 つの判定し直しの仕事が判定する受信箱の記事の数（6） */
export const REJUDGE_ARTICLES_PER_JOB = 500;
/** 記事のタグの 1 行が保存容量に数える大きさ（migrations/0084_article-tags-triggers.sql） */
const ARTICLE_TAG_ROW_BYTES = 256;

/** libsql は blob を ArrayBuffer で返すので、Uint8Array にそろえる */
function asBytes(value: unknown): Uint8Array | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new TypeError("blob column is not bytes");
}

export type JudgingCursor = { createdAt: number; articleId: string };

export type JudgingState = {
  revision: number;
  revisedAt: number;
  cursor: JudgingCursor | null;
  finished: boolean;
  cursorMovedAt: number;
  /** 読んだときの DB の時計 */
  dbNow: number;
};

/** 人ごとのタグの版と判定し直しの位置。まだ版を上げたことがなければ undefined */
export async function readJudgingState(
  db: Database,
  userId: string,
): Promise<JudgingState | undefined> {
  const row = await getRow<{
    revision: number;
    revisedAt: number;
    cursorCreatedAt: number | null;
    cursorArticleId: string | null;
    finished: number;
    cursorMovedAt: number;
    dbNow: number;
  }>(
    db,
    sql`select revision, revised_at as "revisedAt", cursor_created_at as "cursorCreatedAt",
      cursor_article_id as "cursorArticleId", finished, cursor_moved_at as "cursorMovedAt",
      ${DB_NOW_MS} as "dbNow"
    from tag_judging where user_id = ${userId}`,
  );
  if (!row) return undefined;
  return {
    revision: row.revision,
    revisedAt: row.revisedAt,
    cursor:
      row.cursorCreatedAt !== null && row.cursorArticleId !== null
        ? { createdAt: row.cursorCreatedAt, articleId: row.cursorArticleId }
        : null,
    finished: row.finished !== 0,
    cursorMovedAt: row.cursorMovedAt,
    dbNow: row.dbNow,
  };
}

export type JudgedTag = {
  id: string;
  name: string;
  description: string;
  nameEmbeddingInput: string | null;
  nameEmbedding: Uint8Array | null;
  vector: Uint8Array | null;
  vectorTagRevision: number | null;
  vectorEmbeddingRevision: number | null;
  vectorJudgeRevision: number | null;
  statsMean: number | null;
  statsStdDev: number | null;
  statsCount: number | null;
  vectorSourceHash: string | null;
  vectorHash: string | null;
  judgedHash: string | null;
};

/** その人の有効なタグ（作った順） */
export async function listJudgedTags(db: Database, userId: string): Promise<JudgedTag[]> {
  const rows = await db.all<JudgedTag>(sql`
    select id, name, description, name_embedding_input as "nameEmbeddingInput",
      name_embedding as "nameEmbedding", vector, vector_tag_revision as "vectorTagRevision",
      vector_embedding_revision as "vectorEmbeddingRevision",
      vector_judge_revision as "vectorJudgeRevision", stats_mean as "statsMean",
      stats_std_dev as "statsStdDev", stats_count as "statsCount",
      vector_source_hash as "vectorSourceHash", vector_hash as "vectorHash",
      judged_hash as "judgedHash"
    from tags
    where user_id = ${userId} and deleted_at is null
    order by created_at, rowid
  `);
  return rows.map((row) => ({
    ...row,
    nameEmbedding: asBytes(row.nameEmbedding),
    vector: asBytes(row.vector),
  }));
}

/** タグのベクトルが、その人の今の版で作られているか（判定し直しの残りと、定期実行が拾う人。6） */
export function isVectorAtRevision(
  tag: Pick<JudgedTag, "vectorTagRevision">,
  revision: number,
): boolean {
  return tag.vectorTagRevision === revision;
}

/** タグのベクトルが、その人の今の版と、今の埋め込みの版・判定の版で作られているか（作り直すか。1） */
export function isVectorCurrent(
  tag: Pick<JudgedTag, "vectorTagRevision" | "vectorEmbeddingRevision" | "vectorJudgeRevision">,
  input: { revision: number; embeddingRevision: number },
): boolean {
  return (
    tag.vectorTagRevision === input.revision &&
    tag.vectorEmbeddingRevision === input.embeddingRevision &&
    tag.vectorJudgeRevision === JUDGE_REVISION
  );
}

/**
 * 手で付け外しした記事の埋め込み（1）。消した印のない手直しの行のうち、記事に今の埋め込みの版の埋め込みが
 * あるものだけ
 */
export async function readManualEmbeddings(
  db: Database,
  input: { userId: string; embeddingRevision: number },
): Promise<{ tagId: string; articleId: string; on: number; embedding: Uint8Array }[]> {
  const rows = await db.all<{
    tagId: string;
    articleId: string;
    on: number;
    embedding: unknown;
  }>(sql`
    select g.tag_id as "tagId", g.article_id as "articleId", g."on", x.embedding
    from article_tags g
    join article_analyses x on x.article_id = g.article_id
    where g.user_id = ${input.userId} and g.kind = 'manual' and g.deleted_at is null
      and x.embedding_revision = ${input.embeddingRevision} and x.embedding is not null
    -- 足す順を決める（浮動小数の足し算の順で、ベクトルとハッシュが揺れないように）
    order by g.tag_id, g.article_id
  `);
  return rows.map((row) => ({ ...row, embedding: asBytes(row.embedding) ?? new Uint8Array() }));
}

/** 統計を求める記事の埋め込み（2）。受信箱の、今の埋め込みの版の埋め込みがある記事のうち新しいもの */
export async function readStatsSample(
  db: Database,
  input: { userId: string; embeddingRevision: number },
): Promise<Uint8Array[]> {
  const rows = await db.all<{ embedding: unknown }>(sql`
    select x.embedding
    from user_articles ua
    join article_analyses x on x.article_id = ua.article_id
    where ua.user_id = ${input.userId}
      and x.embedding_revision = ${input.embeddingRevision} and x.embedding is not null
    order by ua.created_at desc, ua.article_id desc
    limit ${STATS_SAMPLE_SIZE}
  `);
  return rows.map((row) => asBytes(row.embedding) ?? new Uint8Array());
}

/** その人のタグの版が、読んだときのままであること（書く文の中で確かめる） */
const sameRevision = (userId: string, revision: number) =>
  sql`(select revision from tag_judging where user_id = ${userId}) = ${revision}`;

/**
 * タグのベクトルと統計を書く（1、2）。その人の版と、ベクトルのタグの版が読んだときのままで、タグが有効な
 * ときだけ書く。書けなければ
 * false（版が変わった。新しい版の判定し直しがやり直す）
 */
export async function writeTagVector(
  db: Database,
  input: {
    userId: string;
    tagId: string;
    revision: number;
    /** 読んだときのベクトルのタグの版 */
    readVectorTagRevision: number | null;
    embeddingRevision: number;
    startedAt: Date;
    nameEmbeddingInput: string;
    nameEmbedding: Uint8Array | null;
    vector: Uint8Array | null;
    stats: { mean: number; stdDev: number; count: number } | null;
    /** 統計を除いた入力のハッシュと、統計を含むベクトルの入力のハッシュ */
    sourceHash: string;
    vectorHash: string;
  },
): Promise<boolean> {
  const row = await getRow<{ id: string }>(
    db,
    sql`update tags set
      name_embedding_input = ${input.nameEmbeddingInput},
      name_embedding = ${input.nameEmbedding},
      vector = ${input.vector},
      vector_tag_revision = ${input.revision},
      vector_embedding_revision = ${input.embeddingRevision},
      vector_judge_revision = ${JUDGE_REVISION},
      vector_started_at = ${input.startedAt.getTime()},
      stats_mean = ${input.stats?.mean ?? null},
      stats_std_dev = ${input.stats?.stdDev ?? null},
      stats_count = ${input.stats?.count ?? null},
      vector_source_hash = ${input.sourceHash},
      vector_hash = ${input.vectorHash},
      -- ハッシュが変わったタグは、判定を書き始める前に、判定し終えたハッシュを空にする（6）
      judged_hash = case when judged_hash = ${input.vectorHash} then judged_hash else null end
    where id = ${input.tagId} and user_id = ${input.userId} and deleted_at is null
      and vector_tag_revision is ${input.readVectorTagRevision}
      and ${sameRevision(input.userId, input.revision)}
    returning id`,
  );
  return row !== undefined;
}

export type RejudgeRow = {
  createdAt: number;
  articleId: string;
  embeddingRevision: number | null;
  embedding: Uint8Array | null;
};

/** 判定し直しの次の受信箱の行（受信箱に入った時刻と記事の ID の新しい順に、位置のあとから） */
export async function readRejudgePage(
  db: Database,
  input: { userId: string; cursor: JudgingCursor | null; limit: number },
): Promise<RejudgeRow[]> {
  const after = input.cursor
    ? sql`and (ua.created_at < ${input.cursor.createdAt}
        or (ua.created_at = ${input.cursor.createdAt} and ua.article_id < ${input.cursor.articleId}))`
    : sql``;
  const rows = await db.all<RejudgeRow>(sql`
    select ua.created_at as "createdAt", ua.article_id as "articleId",
      x.embedding_revision as "embeddingRevision", x.embedding
    from user_articles ua
    left join article_analyses x on x.article_id = ua.article_id
    where ua.user_id = ${input.userId} ${after}
    order by ua.created_at desc, ua.article_id desc
    limit ${input.limit}
  `);
  return rows.map((row) => ({ ...row, embedding: asBytes(row.embedding) }));
}

export type ArticleTagState = {
  tagId: string;
  articleId: string;
  kind: "auto" | "manual";
  on: number;
  deleted: number;
};

/** その人の、指定した記事の記事のタグの行（消した印のある行も） */
export function readArticleTagStates(
  db: Database,
  input: { userId: string; articleIds: readonly string[] },
): Promise<ArticleTagState[]> {
  if (input.articleIds.length === 0) return Promise.resolve([]);
  return db.all<ArticleTagState>(sql`
    select tag_id as "tagId", article_id as "articleId", kind, "on", deleted_at is not null as deleted
    from article_tags
    where user_id = ${input.userId}
      and article_id in (select value from json_each(${JSON.stringify(input.articleIds)}))
  `);
}

/** 自動の書き込みの確かめ（2）。タグが有効で本人のもの、記事が本人の受信箱にある、版が読んだときのまま */
function autoWriteAllowed(input: {
  userId: string;
  tagId: SQL | string;
  articleId: string;
  revision: number;
}) {
  return sql`exists (
      select 1 from tags t
      where t.id = ${input.tagId} and t.user_id = ${input.userId} and t.deleted_at is null
    ) and exists (
      select 1 from user_articles ua
      where ua.user_id = ${input.userId} and ua.article_id = ${input.articleId}
    ) and ${sameRevision(input.userId, input.revision)}`;
}

/** 書いたあとの使用量が、片付けの始まる 90% の手前に収まること（7。書く文の中で確かめる） */
const fitsAfterNewRow = sql`(
    select su.bytes + ${ARTICLE_TAG_ROW_BYTES} < su.limit_bytes * ${CHAIN_STORAGE_SHARE.share}
    from storage_usage su where su.id = 1
  ) and not exists (select 1 from content_sizes where bytes is null)`;

/**
 * 自動で付ける（2、7）。消した印の行があれば生き返らせ（使用量によらない）、なければ行を作る（書いたあとの
 * 使用量が 90% 以上になるなら作らない）。消した印のない行（手で付け外しした行と、自動で付いた行）は変えない。
 *
 * @returns 見える状態を変えたら written。書けなかったら not_written（版やタグや受信箱が変わったか、使用量が
 *   足りない。呼ぶ側が見分ける）
 */
export async function attachAutoTag(
  db: Database,
  input: { userId: string; tagId: string; articleId: string; revision: number },
): Promise<"written" | "not_written"> {
  const revived = await getRow<{ id: string }>(
    db,
    sql`update article_tags set kind = 'auto', "on" = 1, deleted_at = null, seq = ${nextSeq(articleTags)}
    where tag_id = ${input.tagId} and article_id = ${input.articleId} and user_id = ${input.userId}
      and deleted_at is not null and ${autoWriteAllowed(input)}
    returning id`,
  );
  if (revived) return "written";
  const inserted = await getRow<{ id: string }>(
    db,
    sql`insert into article_tags (id, tag_id, user_id, article_id, kind, "on", seq)
    select ${crypto.randomUUID()}, ${input.tagId}, ${input.userId}, ${input.articleId}, 'auto', 1,
      ${nextSeq(articleTags)}
    where ${autoWriteAllowed(input)} and ${fitsAfterNewRow}
    on conflict (tag_id, article_id) do nothing
    returning id`,
  );
  return inserted ? "written" : "not_written";
}

/**
 * 自動で付いた行に、消した印と新しい変更番号を付ける（2）。手で付け外しした行は変えない。tagId を省くと、その
 * 記事のその人の自動で付いた行すべて（埋め込みが空・失敗の記事。2）。
 *
 * @returns 印を付けた行の数
 */
export async function detachAutoTags(
  db: Database,
  input: { userId: string; articleId: string; revision: number; tagId?: string },
): Promise<number> {
  const rows = await db.all<{ id: string }>(sql`
    update article_tags set deleted_at = ${DB_NOW_MS}, seq = ${nextSeq(articleTags)}
    where user_id = ${input.userId} and article_id = ${input.articleId}
      and kind = 'auto' and deleted_at is null
      ${input.tagId === undefined ? sql`` : sql`and tag_id = ${input.tagId}`}
      and ${autoWriteAllowed({ ...input, tagId: sql`article_tags.tag_id` })}
    returning id
  `);
  return rows.length;
}

/**
 * 判定し直しをたどり終えたタグに、その仕事が使ったハッシュを判定し終えたハッシュとして書く（6）。版と位置が
 * 読んだときのままで、タグの行のハッシュが使ったハッシュのままのときだけ書く。位置を終わりにする前に呼ぶ。
 *
 * @returns 版と位置が読んだときのままだったか
 */
export async function markTagsJudged(
  db: Database,
  input: {
    userId: string;
    revision: number;
    cursor: JudgingCursor | null;
    tags: readonly { id: string; hash: string }[];
  },
): Promise<boolean> {
  const cursor = input.cursor
    ? sql`j.cursor_created_at = ${input.cursor.createdAt} and j.cursor_article_id = ${input.cursor.articleId}`
    : sql`j.cursor_created_at is null and j.cursor_article_id is null`;
  const unchanged = sql`exists (
      select 1 from tag_judging j
      where j.user_id = ${input.userId} and j.revision = ${input.revision} and j.finished = 0 and ${cursor}
    )`;
  if (input.tags.length > 0) {
    await db.run(sql`
      update tags set judged_hash = vector_hash
      where user_id = ${input.userId} and deleted_at is null
        and exists (
          select 1 from json_each(${JSON.stringify(input.tags)}) used
          where used.value ->> 'id' = tags.id and used.value ->> 'hash' = tags.vector_hash
        )
        and ${unchanged}
    `);
  }
  const row = await getRow<{ ok: number }>(db, sql`select ${unchanged} as ok`);
  return row?.ok === 1;
}

/**
 * 判定し直しの位置を進める（6）。版と位置が読んだときのままのときだけ動かす。to が null なら終わりにする。
 *
 * @returns 動かせたか。通らなければ、仕事はそこで終わる
 */
export async function advanceJudgingCursor(
  db: Database,
  input: {
    userId: string;
    revision: number;
    from: JudgingCursor | null;
    to: JudgingCursor | null;
  },
): Promise<boolean> {
  const from = input.from
    ? sql`cursor_created_at = ${input.from.createdAt} and cursor_article_id = ${input.from.articleId}`
    : sql`cursor_created_at is null and cursor_article_id is null`;
  const row = await getRow<{ userId: string }>(
    db,
    sql`update tag_judging set
      cursor_created_at = ${input.to?.createdAt ?? null},
      cursor_article_id = ${input.to?.articleId ?? null},
      finished = ${input.to === null ? 1 : 0},
      cursor_moved_at = ${DB_NOW_MS}
    where user_id = ${input.userId} and revision = ${input.revision} and finished = 0 and ${from}
    returning user_id as "userId"`,
  );
  return row !== undefined;
}

/**
 * 判定し直しの残りの記事の数（6）。有効なタグがなければ 0。ベクトルがその人の今の版で作られていないタグが
 * あれば受信箱の全部、終わっていれば 0、そうでなければ位置よりあとの記事の数
 */
export async function countRejudgeRemaining(db: Database, userId: string): Promise<number> {
  const state = await readJudgingState(db, userId);
  if (!state) return 0;
  // ベクトルは読まず、版だけを読む
  const tags = await db.all<{ vectorTagRevision: number | null }>(sql`
    select vector_tag_revision as "vectorTagRevision" from tags
    where user_id = ${userId} and deleted_at is null
  `);
  if (tags.length === 0) return 0;
  const stale = tags.some((tag) => !isVectorAtRevision(tag, state.revision));
  if (!stale && state.finished) return 0;
  const after =
    !stale && state.cursor
      ? sql`and (created_at < ${state.cursor.createdAt}
          or (created_at = ${state.cursor.createdAt} and article_id < ${state.cursor.articleId}))`
      : sql``;
  const row = await getRow<{ n: number }>(
    db,
    sql`select count(*) as n from user_articles where user_id = ${userId} ${after}`,
  );
  return row?.n ?? 0;
}

/**
 * 判定し直しを拾う人（6）。版を上げてから 1 分たち、判定し直しが終わっていないか、ベクトルがその人の今の版で
 * 作られていない有効なタグがあり、位置を最後に動かしてから 10 分たった人。未着手の判定し直しの仕事がすでに
 * ある人は外し、位置を動かした時刻の古い順に拾う
 */
export async function findStalledJudging(
  db: Database,
  input: { limit: number },
): Promise<string[]> {
  const rows = await db.all<{ userId: string }>(sql`
    select j.user_id as "userId" from tag_judging j
    where j.revised_at <= ${DB_NOW_MS} - ${REJUDGE_DELAY_MS}
      and j.cursor_moved_at <= ${DB_NOW_MS} - ${10 * 60 * 1000}
      and exists (select 1 from tags t where t.user_id = j.user_id and t.deleted_at is null)
      and (
        j.finished = 0 or exists (
          select 1 from tags t
          where t.user_id = j.user_id and t.deleted_at is null
            and t.vector_tag_revision is not j.revision
        )
      )
      -- 判定し直しの仕事の枠の名前（src/platform/node/job-queue.ts の slotOf）
      and not exists (
        select 1 from job_queue q where q.slot = 'tag-rejudge:' || j.user_id and q.attempts = 0
      )
    order by j.cursor_moved_at
    limit ${input.limit}
  `);
  return rows.map((row) => row.userId);
}
