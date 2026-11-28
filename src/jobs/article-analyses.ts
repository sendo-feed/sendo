import {
  type AnalysisStatus,
  analysisRowBytes,
  CHAIN_STORAGE_SHARE,
  candidatesBytes,
  deleteReplacedCandidates,
  getAnalysisVersions,
  hasSameSummary,
  insertCandidates,
  readAnalysisSource,
  recordAnalysis,
} from "../db/article-analyses";
import { readArticleCategories } from "../db/article-categories";
import { configureStorage, readStorageUsage } from "../db/storage";
import { escapeHtml } from "../lib/html";
import type { ArticleAnalysisResult, Platform } from "../platform";
import { ANALYSIS_ARTICLES_PER_JOB } from "./job";

type AnalysisPlatform = Pick<Platform, "db" | "content" | "articleAnalysis" | "retentionConfig">;

/** 1 件の解析の結末。capacity なら、その仕事の残りの記事を解析しない */
type AnalysisOutcome = "analyzed" | "skipped" | "missing" | "capacity";

/**
 * 指定した記事を解析して保存する（docs/decisions/article-analysis.md の 1、3〜5）。新しい記事の連鎖の
 * 解析で、書いたあとの使用量が 90% 以上になるなら書かない。容量で止まったら、残りの記事は解析せず、
 * 続きも積まない（拾い直しと遡及が拾う）。1 件の失敗では止まらない
 */
export async function analyzeArticles(
  platform: AnalysisPlatform,
  articleIds: readonly string[],
): Promise<void> {
  await configureStorage(platform.db, platform.retentionConfig.maxBytes);
  for (const articleId of articleIds.slice(0, ANALYSIS_ARTICLES_PER_JOB)) {
    let outcome: AnalysisOutcome;
    try {
      outcome = await analyzeArticle(platform, articleId, CHAIN_STORAGE_SHARE);
    } catch (error) {
      console.warn("could not analyze article", { articleId, error });
      continue;
    }
    if (outcome === "capacity") {
      console.warn("article analysis deferred: storage is nearly full or still being measured", {
        articleId,
      });
      return;
    }
  }
}

/** 1 件の記事を解析して保存する */
async function analyzeArticle(
  platform: AnalysisPlatform,
  articleId: string,
  share: number,
): Promise<AnalysisOutcome> {
  const { db, articleAnalysis: analyzer } = platform;
  const current = await getAnalysisVersions(db, articleId);
  const wantCandidates =
    current?.candidateRevision == null || current.candidateRevision < analyzer.candidateRevision;
  const wantEmbedding =
    current?.embeddingRevision == null || current.embeddingRevision < analyzer.embeddingRevision;
  if (!wantCandidates && !wantEmbedding) return "skipped";

  // 推論の前に使用量を読み、上限の割合を超えていれば計算しない（決定の 4）
  if (!(await hasRoom(platform, analysisRowBytes(null), share))) return "capacity";

  const source = await readAnalysisSource(db, articleId);
  if (!source) return "missing";
  let html = source.pageHtml;
  if (html === null && source.contentKey !== null) {
    try {
      html = await platform.content.get(source.contentKey);
    } catch (error) {
      // 本文の置き場が読めない記事は、本文なしで解析する（決定の 3）
      console.warn("could not read article analysis input; analyzing without the body", {
        articleId,
        error,
      });
    }
  }
  const summary = source.summary ?? "";
  const summaryHash = await hashSummary(summary);
  // 同じフィードのほかの記事と同じ要約は、入力に使わない（決定の 8）
  const ownSummary =
    summaryHash !== null &&
    !(await hasSameSummary(db, { articleId, feedId: source.feedId, summaryHash }));

  let result: ArticleAnalysisResult | null;
  try {
    result = await analyzer.analyze({
      title: source.title ?? "",
      // 要約はプレーンテキスト。Rust は HTML として読むので、文字の `<` をタグにしない
      summary: ownSummary ? escapeHtml(summary) : "",
      html: html ?? "",
      categories: await readArticleCategories(db, articleId),
      candidates: wantCandidates,
      embedding: wantEmbedding,
    });
  } catch (error) {
    // Rust が失敗した記事は「失敗」として記録し、同じ版では解析し直さない（決定の 3）
    console.warn("article analysis failed", { articleId, error });
    result = null;
  }

  // 決めた次元でないベクトルは保存せず、埋め込みだけを「失敗」にする（決定の 7。候補は作る。決定の 5）
  const badDimension = result?.embedding != null && result.embedding.length !== analyzer.dimension;
  if (badDimension) {
    console.warn("article analysis returned an unexpected dimension", {
      articleId,
      dimension: result?.embedding?.length,
    });
  }
  const vector =
    wantEmbedding && result?.embedding && !badDimension ? toLittleEndian(result.embedding) : null;
  const reservedBytes = analysisRowBytes(vector);
  let candidates:
    | { revision: number; status: AnalysisStatus; generation: string | null }
    | undefined;
  if (wantCandidates) {
    const list = result?.candidates;
    if (result === null || list === undefined) {
      candidates = { revision: analyzer.candidateRevision, status: "failed", generation: null };
    } else if (list.length === 0) {
      candidates = { revision: analyzer.candidateRevision, status: "empty", generation: null };
    } else {
      // 候補の行を先に入れ、解析の行に世代を書いて済んだ印にする（決定の 5）
      const generation = crypto.randomUUID();
      const inserted = await insertCandidates(db, {
        articleId,
        generation,
        candidates: list,
        reservedBytes,
        share,
      });
      if (inserted === 0) {
        // 入らなかった：記事が消えたか、容量が足りない（候補の行と解析の行を合わせて確かめた）
        const bytes = reservedBytes + candidatesBytes(list);
        return (await hasRoom(platform, bytes, share)) ? "missing" : "capacity";
      }
      candidates = { revision: analyzer.candidateRevision, status: "done", generation };
    }
  }
  const embedding = wantEmbedding
    ? {
        revision: analyzer.embeddingRevision,
        status: (result === null || badDimension
          ? "failed"
          : vector === null
            ? "empty"
            : "done") as AnalysisStatus,
        vector,
      }
    : undefined;
  const recorded = await recordAnalysis(db, {
    articleId,
    summaryHash,
    ...(candidates && { candidates }),
    ...(embedding && { embedding }),
    share,
  });
  if (recorded) {
    // 入れ替わった古い世代の候補の行を消す。落ちて残っても、1 日 1 回の片付けが消す
    if (candidates && current?.candidateGeneration) {
      await deleteReplacedCandidates(db, { articleId, generation: current.candidateGeneration });
    }
    return "analyzed";
  }
  // 書けなかった：記事が消えたか、重なった解析が先に同じ版を書いたか、容量が足りない
  return (await hasRoom(platform, reservedBytes, share)) ? "skipped" : "capacity";
}

/** 書いたあとの使用量が上限の割合に収まるか */
async function hasRoom(
  platform: Pick<Platform, "db">,
  bytes: number,
  share: number,
): Promise<boolean> {
  const usage = await readStorageUsage(platform.db);
  // まだ大きさを測っていない本文があるうちは、使用量が少なく出るので書かない（取り込みと同じ）
  return usage.unmeasured === 0 && usage.bytes + bytes < usage.limitBytes * share;
}

/**
 * 要約を NFKC にして空白をそろえた文の SHA-256（docs/decisions/article-analysis.md の 8）。空なら null
 */
export async function hashSummary(summary: string): Promise<string | null> {
  const normalized = summary.normalize("NFKC").split(/\s+/u).filter(Boolean).join(" ");
  if (normalized === "") return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** float32 のリトルエンディアンのバイト列にする（決定の 7） */
function toLittleEndian(vector: Float32Array): Uint8Array {
  const bytes = new Uint8Array(vector.length * 4);
  const view = new DataView(bytes.buffer);
  vector.forEach((value, index) => {
    view.setFloat32(index * 4, value, true);
  });
  return bytes;
}

/**
 * 記事の解析の仕事を、その記事について積む（ページの本文を抜いた・抜けなかったを記録したとき、
 * ページから抜かない記事を取り込んだとき。docs/decisions/article-analysis.md の 1）。
 * ANALYSIS_ARTICLES_PER_JOB 件ずつの仕事に分ける。積めなくても、呼んだ側の処理は失敗にしない
 */
export async function enqueueArticleAnalyses(
  platform: Pick<Platform, "jobs">,
  articleIds: readonly string[],
): Promise<void> {
  const jobs = [];
  for (let i = 0; i < articleIds.length; i += ANALYSIS_ARTICLES_PER_JOB) {
    jobs.push({
      type: "analyze-articles" as const,
      articleIds: articleIds.slice(i, i + ANALYSIS_ARTICLES_PER_JOB),
    });
  }
  if (jobs.length === 0) return;
  try {
    await platform.jobs.enqueue(jobs);
  } catch (error) {
    console.warn("could not enqueue article analysis", { error });
  }
}
