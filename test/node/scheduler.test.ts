import { afterEach, describe, expect, it, vi } from "vitest";
import { nextScheduledTime, startScheduler } from "../../src/platform/node/scheduler";

describe("コンテナ版の定期実行", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("時計の 10 分の区切りに合わせる（Cloudflare 版の Cron と同じ）", () => {
    expect(nextScheduledTime(new Date("2026-11-16T17:59:59.999Z")).toISOString()).toBe(
      "2026-11-16T18:00:00.000Z",
    );
    expect(nextScheduledTime(new Date("2026-11-16T18:00:00.000Z")).toISOString()).toBe(
      "2026-11-16T18:10:00.000Z",
    );
  });

  it("区切りごとに、予定した区切りの時刻を渡して呼ぶ", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-16T17:55:00Z") });
    const tick = vi.fn(async (_: Date) => {});
    const scheduler = startScheduler(tick);

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    await scheduler.stop();

    expect(tick.mock.calls.map(([time]) => time.toISOString())).toEqual([
      "2026-11-16T18:00:00.000Z",
      "2026-11-16T18:10:00.000Z",
    ]);
  });

  it("前の回が終わっていなければ、その区切りは飛ばす。例外が出ても続ける", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-16T18:00:00Z") });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    let release: () => void = () => {};
    const tick = vi
      .fn<(time: Date) => Promise<void>>()
      .mockImplementationOnce(() => new Promise<void>((resolve) => (release = resolve)))
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue(undefined);
    const scheduler = startScheduler(tick);

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000); // 1 回目が始まる
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000); // 1 回目が終わっていないので飛ばす
    release();
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000); // 2 回目は例外
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000); // 3 回目も呼ばれる
    await scheduler.stop();

    expect(tick).toHaveBeenCalledTimes(3);
  });
});
