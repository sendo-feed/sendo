import { rewindBackfill } from "../db/article-analysis-backfill";
import { leaseDueFeeds, MAX_LEASE } from "../db/feeds";
import { type Platform, SCHEDULE_INTERVAL_MINUTES } from "../platform";
import { enqueueAnalysisBackground } from "./article-analyses";
import { enqueueStalledTagJudging } from "./tag-judging";

/**
 * キューに積んでから取得が終わるまでの猶予。これを過ぎても取得が記録されなければ、
 * 次の定期実行でもう一度積まれる（取得の途中で落ちた場合の救済）。
 */
const LEASE_MS = 15 * 60 * 1000;

/**
 * 1 回の定期実行で借りる回数の上限。1 回の定期実行が扱う量を抑える（docs/decisions/jobs.md の 4）。
 * 残りは次の定期実行（5 分後）で積む
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
  let total = await platform.jobs.enqueueDueDiscordFetches(now, MAX_LEASE * MAX_LEASE_ROUNDS);
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

/** 未処理分は次回も拾えるので、投入の失敗で取得や起動を止めない */
export async function enqueueLanguageDetection(platform: Pick<Platform, "jobs">): Promise<void> {
  try {
    await platform.jobs.enqueue([{ type: "detect-article-languages" }]);
  } catch (error) {
    console.warn("could not enqueue language detection; retrying at the next schedule", { error });
  }
}

/**
 * 訳文の行の手入れを積む（docs/decisions/jobs.md の 12、translation.md の 1、7）。止まった翻訳を
 * 戻すのは API キーがなくても行うので、毎回積む。投入の失敗で、ほかの定期実行を止めない
 */
export async function enqueueTranslationMaintenance(
  platform: Pick<Platform, "jobs">,
): Promise<void> {
  try {
    await platform.jobs.enqueue([{ type: "maintain-translations" }]);
  } catch (error) {
    console.warn("could not enqueue translation maintenance; retrying at the next schedule", {
      error,
    });
  }
}

/**
 * 定期実行の時刻が、1 日 1 回の片付けの時刻なら、片付けの仕事を積む（docs/decisions/retention.md の 4）。
 *
 * 定期実行は SCHEDULE_INTERVAL_MINUTES おきに動くので、片付けの時刻の最初のその分の間に
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
    scheduledTime.getUTCMinutes() >= SCHEDULE_INTERVAL_MINUTES
  ) {
    return false;
  }
  await platform.jobs.enqueue([{ type: "clean-up" }]);
  return true;
}

/**
 * 記事の言語の判定と検索の索引を積む間隔（docs/decisions/jobs.md の 12）。取得の時刻とは関係が
 * ないので、定期実行を詰めても回数を増やさない（article-language.md の 5、article-search.md の 3）
 */
export const BACKGROUND_INTERVAL_MS = 10 * 60 * 1000;

/** 予定された時刻が、言語の判定と検索の索引を積む区切りか */
export function isBackgroundSlot(scheduledTime: Date): boolean {
  return scheduledTime.getTime() % BACKGROUND_INTERVAL_MS === 0;
}

/**
 * 定期実行（SCHEDULE_INTERVAL_MINUTES おき）の中身。プロセスの中のタイマー（platform/node/scheduler.ts）
 * から呼ぶ。取得の時期が来たフィードは毎回積み、言語の判定と検索の索引は 10 分の区切りでだけ積む
 *
 * @param scheduledTime 定期実行が予定された時刻
 */
export async function runScheduled(
  platform: Pick<Platform, "db" | "jobs" | "now" | "articleAnalysis" | "syncUpdates">,
  scheduledTime: Date,
): Promise<void> {
  if (await enqueueDailyCleanUp(platform, scheduledTime)) {
    console.info("enqueued daily clean-up");
    // 1 日 1 回の片付けのときに、記事の解析の遡及を先頭に戻す（docs/decisions/article-analysis.md の 2）。
    // 拾い直しの 1 日を過ぎて取り残された記事も、ここから拾う。容量で積まれる片付けでは戻さない
    try {
      await rewindBackfill(platform.db);
    } catch (error) {
      console.warn("could not rewind article analysis backfill", { error });
    }
  }
  const count = await enqueueDueFeeds(platform);
  if (count > 0) console.info("enqueued due feeds", { count });
  await enqueueTranslationMaintenance(platform);
  if (!isBackgroundSlot(scheduledTime)) return;
  await enqueueLanguageDetection(platform);
  // 記事の解析の遡及と拾い直し（docs/decisions/article-analysis.md の 2）
  await enqueueAnalysisBackground(platform);
  // 止まった自動のタグ付けの判定し直しと、判定待ちの行が残った人の判定（docs/decisions/auto-tagging.md の 5、6）
  try {
    await enqueueStalledTagJudging(platform);
  } catch (error) {
    console.warn("could not enqueue stalled tag rejudges; retrying at the next schedule", {
      error,
    });
  }
  try {
    await platform.jobs.enqueue([{ type: "index-article-search" }]);
  } catch (error) {
    console.warn("could not enqueue article search indexing; retrying at the next schedule", {
      error,
    });
  }
}
