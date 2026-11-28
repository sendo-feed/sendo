import {
  type ArticleTagState,
  advanceJudgingCursor,
  attachAutoTag,
  detachAutoTags,
  findStalledJudging,
  isVectorCurrent,
  JUDGE_REVISION,
  type JudgedTag,
  type JudgingCursor,
  listJudgedTags,
  NEGATIVE_WEIGHT,
  POSITIVE_WEIGHT,
  REJUDGE_ARTICLES_PER_JOB,
  REJUDGE_DELAY_MS,
  readArticleTagStates,
  readJudgingState,
  readManualEmbeddings,
  readRejudgePage,
  readStatsSample,
  STATS_MIN_COUNT,
  STATS_MIN_STD_DEV,
  TAG_SCORE_THRESHOLD,
  writeTagVector,
} from "../db/tag-judging";
import { notifySync } from "../lib/sync-notify";
import type { Platform } from "../platform";

/*
 * 自動のタグ付けの判定し直し（docs/decisions/auto-tagging.md の 1、2、6、7）。
 */

/** 定期実行が一度に拾う、判定し直しの止まった人の数 */
const STALLED_PER_SCHEDULE = 100;

type JudgingPlatform = Pick<Platform, "db" | "jobs" | "now" | "articleAnalysis" | "syncUpdates">;

/**
 * その人の判定し直しの仕事を、版を上げた時刻の 1 分あとで積む（6）。未着手の仕事がすでにあれば積まない。
 * タグの API と手の付け外しの API が、書いたあとに呼ぶ（版が上がっていなければ、仕事は何もせずに終わる）
 */
export async function enqueueRejudge(
  platform: Pick<Platform, "db" | "jobs" | "now">,
  userId: string,
): Promise<void> {
  const state = await readJudgingState(platform.db, userId);
  if (!state) return;
  const waitMs = Math.max(0, state.revisedAt + REJUDGE_DELAY_MS - state.dbNow);
  await platform.jobs.enqueue([{ type: "rejudge-tags", userId }], {
    runAt: new Date(platform.now().getTime() + waitMs),
    unlessWaiting: true,
  });
}

/**
 * タグの API と手の付け外しの API が、書いたあとに判定し直しを積む。積めなくても応答は止めない（定期実行が
 * 拾う）
 */
export async function enqueueRejudgeAfterWrite(
  platform: Pick<Platform, "db" | "jobs" | "now">,
  userId: string,
): Promise<void> {
  try {
    await enqueueRejudge(platform, userId);
  } catch (error) {
    console.warn("could not enqueue tag rejudge; the schedule will pick it up", { error });
  }
}

/** 定期実行（10 分の区切り）が、止まった判定し直しを拾う（6） */
export async function enqueueStalledRejudges(platform: JudgingPlatform): Promise<void> {
  const userIds = await findStalledJudging(platform.db, { limit: STALLED_PER_SCHEDULE });
  for (const userId of userIds) {
    await platform.jobs.enqueue([{ type: "rejudge-tags", userId }], { unlessWaiting: true });
  }
}

/**
 * 判定し直しの仕事（6）。その人の今の版を読み、版を上げてから 1 分たっていなければ積み直して終わる。ベクトルを
 * 作り直してから、受信箱を位置から新しい記事の順に 500 件まで判定し、続きを積む
 */
export async function runRejudgeTags(platform: JudgingPlatform, userId: string): Promise<void> {
  const { db } = platform;
  const state = await readJudgingState(db, userId);
  if (!state) return;
  const waitMs = state.revisedAt + REJUDGE_DELAY_MS - state.dbNow;
  if (waitMs > 0) {
    await platform.jobs.enqueue([{ type: "rejudge-tags", userId }], {
      runAt: new Date(platform.now().getTime() + waitMs),
      unlessWaiting: true,
    });
    return;
  }
  // 判定し直しを終えていれば何もしない（埋め込みの版や判定の版が変わったときは、版を上げて判定し直す。4）
  if (state.finished) return;
  const embeddingRevision = platform.articleAnalysis.embeddingRevision;
  const revision = state.revision;
  let tags = await listJudgedTags(db, userId);
  if (tags.length === 0) {
    // 有効なタグがなければ、位置を終わりにして終える
    await advanceJudgingCursor(db, { userId, revision, from: state.cursor, to: null });
    return;
  }
  if (tags.some((tag) => !isVectorCurrent(tag, { revision, embeddingRevision }))) {
    if (!(await rebuildVectors(platform, { userId, revision, tags }))) return;
    tags = await listJudgedTags(db, userId);
  }

  const page = await readRejudgePage(db, {
    userId,
    cursor: state.cursor,
    limit: REJUDGE_ARTICLES_PER_JOB,
  });
  if (page.length === 0) {
    await advanceJudgingCursor(db, { userId, revision, from: state.cursor, to: null });
    return;
  }
  const judged = tags.flatMap((tag) => {
    const judge = toJudge(tag);
    return judge ? [judge] : [];
  });
  const states = new Map<string, ArticleTagState>();
  for (const row of await readArticleTagStates(db, {
    userId,
    articleIds: page.map((row) => row.articleId),
  })) {
    states.set(`${row.tagId}\n${row.articleId}`, row);
  }

  let changed = 0;
  let reached: JudgingCursor | null = state.cursor;
  // 行を新しく作れなかった（使用量が足りないか、版・タグ・受信箱が変わった）
  let stopped = false;
  articles: for (const row of page) {
    if (row.embeddingRevision === null || row.embeddingRevision !== embeddingRevision) {
      // 解析の済んでいない記事は飛ばす。埋め込みの版の古い記事（解析し直しを待っている）は書き換えずに残す
      reached = { createdAt: row.createdAt, articleId: row.articleId };
      continue;
    }
    if (row.embedding === null) {
      // 今の版で解析済みで、埋め込みが入力が空・失敗：自動で付いた行に消した印を付ける
      changed += await detachAutoTags(db, { userId, articleId: row.articleId, revision });
      reached = { createdAt: row.createdAt, articleId: row.articleId };
      continue;
    }
    const article = fromLittleEndian(row.embedding);
    for (const tag of tags) {
      const current = states.get(`${tag.id}\n${row.articleId}`);
      const judge = judged.find((item) => item.id === tag.id);
      const on = judge !== undefined && score(judge, article) >= TAG_SCORE_THRESHOLD;
      if (on) {
        // 付いている行（手で付けた・外した行、自動で付いた行）は変えない
        if (current && !current.deleted) continue;
        const written = await attachAutoTag(db, {
          userId,
          tagId: tag.id,
          articleId: row.articleId,
          revision,
        });
        if (written === "written") {
          changed++;
          continue;
        }
        // 書けなかった：理由によらず、この記事から先へ進めずに終え、続きを積まない（使用量が足りなければ 7 の
        // とおり）。版が変われば位置を進める文が通らず、新しい版の判定し直しを API が積む。受信箱の行が消えた
        // ときは、定期実行が拾い、新しい状態で判定する
        stopped = true;
        break articles;
      } else if (current && current.kind === "auto" && !current.deleted) {
        changed += await detachAutoTags(db, {
          userId,
          articleId: row.articleId,
          revision,
          tagId: tag.id,
        });
      }
    }
    reached = { createdAt: row.createdAt, articleId: row.articleId };
  }
  if (changed > 0) await notifySync(platform.syncUpdates.notify, [userId]);

  const done = !stopped && page.length < REJUDGE_ARTICLES_PER_JOB;
  if (reached !== state.cursor || done) {
    const moved = await advanceJudgingCursor(db, {
      userId,
      revision,
      from: state.cursor,
      to: done ? null : reached,
    });
    // 版か位置が変わっていれば、新しい版の判定し直しがやり直す
    if (!moved) return;
  }
  // 止まったときの続きは、定期実行が拾う（位置を最後に動かしてから 10 分たったとき）
  if (!done && !stopped) {
    await platform.jobs.enqueue([{ type: "rejudge-tags", userId }], { unlessWaiting: true });
  }
}

/** 正規化に使えるタグ（ベクトルがあり、統計が条件を満たす。2） */
type Judge = { id: string; vector: Float32Array; norm: number; mean: number; stdDev: number };

function toJudge(tag: JudgedTag): Judge | null {
  if (
    tag.vector === null ||
    tag.statsMean === null ||
    tag.statsStdDev === null ||
    tag.statsCount === null ||
    tag.statsCount < STATS_MIN_COUNT ||
    tag.statsStdDev < STATS_MIN_STD_DEV
  ) {
    return null;
  }
  const vector = fromLittleEndian(tag.vector);
  return { id: tag.id, vector, norm: norm(vector), mean: tag.statsMean, stdDev: tag.statsStdDev };
}

/** タグごとに正規化した類似度（2） */
function score(judge: Judge, article: Float32Array): number {
  return (cosine(judge.vector, judge.norm, article) - judge.mean) / judge.stdDev;
}

/**
 * 有効なタグのベクトルと統計を作り直す（1、2）。名前と説明の埋め込みは、入力が変わったタグだけ推論する。
 *
 * @returns 書けたか。その人の版が変わっていれば false（新しい版の判定し直しがやり直す）
 */
async function rebuildVectors(
  platform: JudgingPlatform,
  input: { userId: string; revision: number; tags: JudgedTag[] },
): Promise<boolean> {
  const { db, articleAnalysis } = platform;
  const embeddingRevision = articleAnalysis.embeddingRevision;
  const startedAt = platform.now();
  const manual = await readManualEmbeddings(db, { userId: input.userId, embeddingRevision });
  const sample = (await readStatsSample(db, { userId: input.userId, embeddingRevision })).map(
    fromLittleEndian,
  );
  for (const tag of input.tags) {
    const text = tag.description === "" ? tag.name : `${tag.name}。${tag.description}`;
    const nameEmbeddingInput = `${embeddingRevision}:${JUDGE_REVISION}:${text}`;
    const nameEmbedding =
      tag.nameEmbeddingInput === nameEmbeddingInput
        ? tag.nameEmbedding && fromLittleEndian(tag.nameEmbedding)
        : await articleAnalysis.embedText(text);
    const vector = nameEmbedding
      ? rocchio(
          nameEmbedding,
          manual.filter((row) => row.tagId === tag.id),
        )
      : null;
    const written = await writeTagVector(db, {
      userId: input.userId,
      tagId: tag.id,
      revision: input.revision,
      readVectorTagRevision: tag.vectorTagRevision,
      embeddingRevision,
      startedAt,
      nameEmbeddingInput,
      nameEmbedding: nameEmbedding ? toLittleEndian(nameEmbedding) : null,
      vector: vector ? toLittleEndian(vector) : null,
      stats: vector ? similarityStats(vector, sample) : null,
    });
    if (!written) return false;
  }
  return true;
}

/**
 * Rocchio の形（1）。名前と説明の埋め込みに、手で付けた記事の平均を 0.5、手で外した記事の平均を −0.25 の
 * 重みで足し、正規化する
 */
export function rocchio(
  nameEmbedding: Float32Array,
  manual: readonly { on: number; embedding: Uint8Array }[],
): Float32Array {
  const vector = Float32Array.from(nameEmbedding);
  const add = (rows: readonly { embedding: Uint8Array }[], weight: number) => {
    if (rows.length === 0) return;
    const scale = weight / rows.length;
    for (const row of rows) {
      const embedding = fromLittleEndian(row.embedding);
      for (let i = 0; i < vector.length; i++)
        vector[i] = (vector[i] ?? 0) + scale * (embedding[i] ?? 0);
    }
  };
  add(
    manual.filter((row) => row.on !== 0),
    POSITIVE_WEIGHT,
  );
  add(
    manual.filter((row) => row.on === 0),
    -NEGATIVE_WEIGHT,
  );
  const length = norm(vector);
  if (length > 0) for (let i = 0; i < vector.length; i++) vector[i] = (vector[i] ?? 0) / length;
  return vector;
}

/** タグのベクトルと記事の類似度の平均と標準偏差（2） */
export function similarityStats(
  vector: Float32Array,
  sample: readonly Float32Array[],
): { mean: number; stdDev: number; count: number } {
  const length = norm(vector);
  const values = sample.map((article) => cosine(vector, length, article));
  const count = values.length;
  if (count === 0) return { mean: 0, stdDev: 0, count: 0 };
  const mean = values.reduce((sum, value) => sum + value, 0) / count;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / count;
  return { mean, stdDev: Math.sqrt(variance), count };
}

function norm(vector: Float32Array): number {
  let sum = 0;
  for (const value of vector) sum += value * value;
  return Math.sqrt(sum);
}

function cosine(vector: Float32Array, vectorNorm: number, other: Float32Array): number {
  let dot = 0;
  let otherSum = 0;
  for (let i = 0; i < vector.length; i++) {
    const value = other[i] ?? 0;
    dot += (vector[i] ?? 0) * value;
    otherSum += value * value;
  }
  const denominator = vectorNorm * Math.sqrt(otherSum);
  return denominator === 0 ? 0 : dot / denominator;
}

/** float32 のリトルエンディアンのバイト列から読む（記事の解析の埋め込みと同じ形） */
function fromLittleEndian(bytes: Uint8Array): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const vector = new Float32Array(bytes.byteLength / 4);
  for (let i = 0; i < vector.length; i++) vector[i] = view.getFloat32(i * 4, true);
  return vector;
}

function toLittleEndian(vector: Float32Array): Uint8Array {
  const bytes = new Uint8Array(vector.length * 4);
  const view = new DataView(bytes.buffer);
  vector.forEach((value, index) => {
    view.setFloat32(index * 4, value, true);
  });
  return bytes;
}
