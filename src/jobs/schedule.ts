import { leaseDueFeeds, MAX_LEASE } from "../db/feeds";
import type { Platform } from "../platform";

/**
 * キューに積んでから取得が終わるまでの猶予。これを過ぎても取得が記録されなければ、
 * 次の定期実行でもう一度積まれる（取得の途中で落ちた場合の救済）。
 */
const LEASE_MS = 15 * 60 * 1000;

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
  for (;;) {
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
}
