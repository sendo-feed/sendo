import {
  aggregateTagCandidates,
  MAX_CANDIDATE_ITEMS,
  readExcludedCandidateKeys,
  type TagCandidate,
} from "../db/tag-candidates";
import type { Platform } from "../platform";

/*
 * タグの候補の一覧（docs/decisions/tags.md の 1、2）。REST API と MCP で同じものを使う。
 */

/** 集計の結果（失敗も）を使い回す長さ */
export const CANDIDATE_REUSE_MS = 60 * 1000;

type Aggregate = { items: TagCandidate[]; pending: number };

/** 置いた集計の結果。at は集計が終わった（失敗した）時刻で、プロセスの時計 */
type Settled = { at: number; candidateRevision: number } & (
  | { aggregate: Aggregate }
  | { error: unknown }
);

type Aggregates = {
  settled: Map<string, Settled>;
  running: Map<string, Promise<Aggregate>>;
};

/** 集計の結果は、Platform ごと（プロセスに 1 つ）にメモリに置く */
const aggregatesByPlatform = new WeakMap<Platform, Aggregates>();

/**
 * 候補の一覧を返す。集計は別のスレッドで流し（platform.heavyRead）、結果は利用者ごとに、集計が終わった
 * 時刻から 1 分未満の間は使い回す。同じ利用者の集計が流れている間に来たリクエストは、その結果を待って使う
 * （1 人が同時に流す集計は 1 本）。集計が失敗したら、失敗した時刻から 1 分未満の間は集計し直さずに同じ
 * 失敗を返す。返すたびに、その時点の有効なタグの照合用の名前と却下の鍵で外し直し、100 件まで返す
 */
export async function listTagCandidates(
  platform: Platform,
  userId: string,
): Promise<{ items: TagCandidate[]; pending: number }> {
  const aggregate = await aggregateFor(platform, userId);
  const excluded = await readExcludedCandidateKeys(platform.db, userId);
  return {
    items: aggregate.items.filter((item) => !excluded.has(item.key)).slice(0, MAX_CANDIDATE_ITEMS),
    pending: aggregate.pending,
  };
}

function aggregateFor(platform: Platform, userId: string): Promise<Aggregate> {
  let aggregates = aggregatesByPlatform.get(platform);
  if (!aggregates) {
    aggregates = { settled: new Map(), running: new Map() };
    aggregatesByPlatform.set(platform, aggregates);
  }
  const { settled, running } = aggregates;
  const now = platform.now().getTime();
  const candidateRevision = platform.articleAnalysis.candidateRevision;
  // 1 分たった結果は、ほかの利用者の分も捨てる（使わなくなった利用者の分をメモリに残さない）。時計が
  // 戻ったときも捨てる
  for (const [id, entry] of settled) {
    if (now - entry.at >= CANDIDATE_REUSE_MS || now < entry.at) settled.delete(id);
  }
  const reusable = settled.get(userId);
  if (reusable && reusable.candidateRevision === candidateRevision) {
    return "aggregate" in reusable
      ? Promise.resolve(reusable.aggregate)
      : Promise.reject(reusable.error);
  }
  const inFlight = running.get(userId);
  if (inFlight) return inFlight;
  const started = aggregateTagCandidates(platform.heavyRead, { userId, candidateRevision })
    .then(
      (aggregate) => {
        settled.set(userId, { at: platform.now().getTime(), candidateRevision, aggregate });
        return aggregate;
      },
      (error: unknown) => {
        settled.set(userId, { at: platform.now().getTime(), candidateRevision, error });
        throw error;
      },
    )
    .finally(() => running.delete(userId));
  running.set(userId, started);
  return started;
}
