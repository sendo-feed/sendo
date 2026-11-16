/**
 * コンテナ版の定期実行（docs/decisions/container.md の 6）。Cloudflare 版の Cron Triggers
 * （wrangler.jsonc の "*\/10 * * * *"）と同じく、時計の 10 分の区切りごとに動かし、
 * 予定した区切りの時刻を渡す（片付けは、その時刻で日本時間 3:00 かを見る。jobs/schedule.ts）。
 */
import { MIN_FETCH_INTERVAL_MINUTES } from "..";

export const SCHEDULE_INTERVAL_MS = MIN_FETCH_INTERVAL_MINUTES * 60 * 1000;

/** at より後の、最初の区切りの時刻 */
export function nextScheduledTime(at: Date, intervalMs = SCHEDULE_INTERVAL_MS): Date {
  return new Date((Math.floor(at.getTime() / intervalMs) + 1) * intervalMs);
}

export interface Scheduler {
  stop(): Promise<void>;
}

/**
 * 区切りごとに tick を呼ぶ。前の tick が終わっていなければ、その区切りは飛ばす。
 * tick の例外はログに出して、次の区切りも続ける
 */
export function startScheduler(
  tick: (scheduledTime: Date) => Promise<void>,
  options: { now?: () => Date; intervalMs?: number } = {},
): Scheduler {
  const now = options.now ?? (() => new Date());
  const intervalMs = options.intervalMs ?? SCHEDULE_INTERVAL_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let stopped = false;

  const arm = () => {
    if (stopped) return;
    const scheduledTime = nextScheduledTime(now(), intervalMs);
    timer = setTimeout(
      () => {
        if (running === undefined) {
          running = tick(scheduledTime)
            .catch((error) => console.error("scheduled run failed", error))
            .finally(() => {
              running = undefined;
            });
        } else {
          console.warn("skipping a scheduled run; the previous one is still running");
        }
        arm();
      },
      Math.max(0, scheduledTime.getTime() - now().getTime()),
    );
  };
  arm();

  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await running;
    },
  };
}
