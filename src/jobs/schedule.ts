import { leaseDueFeeds, MAX_LEASE } from "../db/feeds";
import { MIN_FETCH_INTERVAL_MINUTES, type Platform } from "../platform";

/**
 * キューに積んでから取得が終わるまでの猶予。これを過ぎても取得が記録されなければ、
 * 次の定期実行でもう一度積まれる（取得の途中で落ちた場合の救済）。
 */
const LEASE_MS = 15 * 60 * 1000;

/**
 * 1 回の定期実行で借りる回数の上限。1 回につき 2 クエリなので、D1 のクエリの上限
 * （QUERY_BUDGET）に収まる。残りは次の定期実行（10 分後）で積む
 */
export const MAX_LEASE_ROUNDS = 20;

/**
 * 取得の時期が来たフィードを、取得のキューに積む。定期実行（Cron）から呼ぶ。
 * @returns 積んだフィードの数
 */
export async function enqueueDueFeeds(
  platform: Pick<Platform, "db" | "jobs" | "now">,
): Promise<number> {
  const now = platform.now();
  let total = 0;
  // 一度に借りられる数には上限があるので、時期の来たものがなくなるまで繰り返す
  for (let round = 0; round < MAX_LEASE_ROUNDS; round++) {
    const ids = await leaseDueFeeds(platform.db, {
      now,
      leaseUntil: new Date(now.getTime() + LEASE_MS),
      limit: MAX_LEASE,
    });
    if (ids.length === 0) return total;
    await platform.jobs.enqueue(ids.map((feedId) => ({ type: "fetch-feed", feedId })));
    total += ids.length;
    if (ids.length < MAX_LEASE) return total;
  }
  return total;
}

/** 1 日 1 回の片付けを積む時刻（UTC の時）。日本時間の 3 時 */
export const CLEAN_UP_HOUR_UTC = 18;

/**
 * 定期実行の時刻が、1 日 1 回の片付けの時刻なら、片付けの仕事を積む（docs/decisions/retention.md の 4）。
 *
 * 定期実行は MIN_FETCH_INTERVAL_MINUTES おきに動くので、片付けの時刻の最初のその分の間に
 * 予定された 1 回だけが積む。その回が落ちたら、その日は片付けない（翌日にまとめて片付ける）
 *
 * @param scheduledTime 定期実行が予定された時刻（実際に動き出した時刻ではない）
 * @returns 積んだら true
 */
export async function enqueueDailyCleanUp(
  platform: Pick<Platform, "jobs">,
  scheduledTime: Date,
): Promise<boolean> {
  if (
    scheduledTime.getUTCHours() !== CLEAN_UP_HOUR_UTC ||
    scheduledTime.getUTCMinutes() >= MIN_FETCH_INTERVAL_MINUTES
  ) {
    return false;
  }
  await platform.jobs.enqueue([{ type: "clean-up" }]);
  return true;
}
