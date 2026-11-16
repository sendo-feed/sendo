import type { Database } from "../db";
import { recentPublishedTimes } from "../db/articles";
import type { Feed } from "../db/schema";

/*
 * フィードごとの取得の間隔（docs/decisions/jobs.md の 7、8）。
 *
 * 設定の間隔（platform.fetchConfig.intervalMs）を下限、1 日を上限にして、記事の出るペースから決める。
 * 失敗したときに延ばす間隔と、429 ／ 503 の Retry-After の扱いもここに置く。
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** 取得の間隔の上限。設定の間隔がこれより長ければ、設定の間隔 */
export const MAX_FETCH_INTERVAL_MS = DAY_MS;

/** 記事の出るペースを見る期間 */
export const PACE_WINDOW_MS = 7 * DAY_MS;

/** 記事の出るペースを見るのに使う記事の数の上限（新しい順） */
export const PACE_SAMPLE = 50;

/** 取得の間隔の上限。設定の間隔（下限）が 1 日より長ければ、設定の間隔 */
export function maxFetchInterval(minMs: number): number {
  return Math.max(MAX_FETCH_INTERVAL_MS, minMs);
}

/**
 * フィードの今の取得の間隔。まだ決めていなければ設定の間隔。設定が変わったときに備えて、
 * 下限と上限に収める
 */
export function currentFetchInterval(feed: Pick<Feed, "fetchIntervalMs">, minMs: number): number {
  return clamp(feed.fetchIntervalMs ?? minMs, minMs, maxFetchInterval(minMs));
}

/**
 * 記事の公開日時から、取得の間隔を決める。
 *
 * - 期間（直近 7 日）に入る記事がなければ、上限
 * - あれば、いちばん古いものから今までの時間を件数で割ったものを記事の平均の間隔とみなし、
 *   その 3 分の 1 にする。公開日時が今より先の記事は、今に出たものとして数える
 * - 下限（設定の間隔）と上限に収める
 */
export function decideFetchInterval(
  publishedAt: readonly Date[],
  input: { now: Date; minMs: number },
): number {
  const now = input.now.getTime();
  const maxMs = maxFetchInterval(input.minMs);
  const times = publishedAt.map((date) => date.getTime()).filter((t) => t > now - PACE_WINDOW_MS);
  if (times.length === 0) return maxMs;

  const oldest = Math.min(now, ...times);
  const averageGap = (now - oldest) / times.length;
  return clamp(Math.round(averageGap / 3), input.minMs, maxMs);
}

/** フィードの記事を DB から読んで、取得の間隔を決め直す */
export async function nextFetchInterval(
  db: Database,
  input: { feedId: string; now: Date; minMs: number },
): Promise<number> {
  const publishedAt = await recentPublishedTimes(db, {
    feedId: input.feedId,
    since: new Date(input.now.getTime() - PACE_WINDOW_MS),
    limit: PACE_SAMPLE,
  });
  return decideFetchInterval(publishedAt, input);
}

/**
 * 取得に失敗したときの、次の取得までの間隔。フィードの今の間隔を、失敗の回数で倍々に延ばす。
 * 上限は、取得の間隔の上限と同じ
 */
export function backoffInterval(input: {
  intervalMs: number;
  errorCount: number;
  minMs: number;
}): number {
  return Math.min(input.intervalMs * 2 ** input.errorCount, maxFetchInterval(input.minMs));
}

/**
 * 相手の Retry-After を、守る長さに収める。なければ 0。上限は、取得の間隔の上限と同じ
 * （1 日。設定の間隔が 1 日より長ければ、設定の間隔）
 */
export function retryAfterWait(retryAfterMs: number | undefined, minMs: number): number {
  if (retryAfterMs === undefined) return 0;
  return Math.min(Math.max(retryAfterMs, 0), maxFetchInterval(minMs));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
