import { describe, expect, it } from "vitest";
import {
  backoffInterval,
  currentFetchInterval,
  decideFetchInterval,
  MAX_FETCH_INTERVAL_MS,
  retryAfterWait,
} from "../../src/jobs/fetch-interval";

const NOW = new Date("2026-11-14T00:00:00Z");
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MIN = 30 * MINUTE;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

describe("decideFetchInterval（docs/decisions/jobs.md の 7）", () => {
  it("記事の平均の間隔の 3 分の 1 にする", () => {
    // 6 時間おきに 4 件。いちばん古いものから今まで 24 時間 ÷ 4 件 ＝ 6 時間、その 3 分の 1
    const times = [ago(6 * HOUR), ago(12 * HOUR), ago(18 * HOUR), ago(24 * HOUR)];
    expect(decideFetchInterval(times, { now: NOW, minMs: MIN })).toBe(2 * HOUR);
  });

  it("記事が出ないまま時間がたつと、間隔が伸びる", () => {
    const times = [ago(2 * HOUR), ago(4 * HOUR)];
    const later = new Date(NOW.getTime() + 20 * HOUR);
    // 4 時間 ÷ 2 件の 3 分の 1 ＝ 40 分。20 時間後は 24 時間 ÷ 2 件の 3 分の 1 ＝ 4 時間
    expect(decideFetchInterval(times, { now: NOW, minMs: MIN })).toBe(40 * MINUTE);
    expect(decideFetchInterval(times, { now: later, minMs: MIN })).toBe(4 * HOUR);
  });

  it("直近 7 日に記事がなければ、上限（1 日）にする", () => {
    expect(decideFetchInterval([], { now: NOW, minMs: MIN })).toBe(MAX_FETCH_INTERVAL_MS);
    expect(decideFetchInterval([ago(8 * DAY)], { now: NOW, minMs: MIN })).toBe(
      MAX_FETCH_INTERVAL_MS,
    );
  });

  it("7 日より前の記事は数えない", () => {
    // 数えるのは 1 時間前の 1 件だけ。1 時間 ÷ 1 件の 3 分の 1 ＝ 20 分
    const times = [ago(HOUR), ago(8 * DAY), ago(9 * DAY)];
    expect(decideFetchInterval(times, { now: NOW, minMs: 10 * MINUTE })).toBe(20 * MINUTE);
  });

  it("下限（設定の間隔）より短く、上限より長くしない", () => {
    const busy = Array.from({ length: 50 }, (_, i) => ago(i * MINUTE));
    expect(decideFetchInterval(busy, { now: NOW, minMs: MIN })).toBe(MIN);
    // 7 日前近くに 1 件だけ：6 日 ÷ 1 件の 3 分の 1 ＝ 2 日 → 1 日
    expect(decideFetchInterval([ago(6 * DAY)], { now: NOW, minMs: MIN })).toBe(DAY);
  });

  it("設定の間隔が 1 日より長ければ、それを上限にもする", () => {
    expect(decideFetchInterval([], { now: NOW, minMs: 2 * DAY })).toBe(2 * DAY);
    expect(decideFetchInterval([ago(HOUR)], { now: NOW, minMs: 2 * DAY })).toBe(2 * DAY);
  });

  it("公開日時が今より先の記事は、今に出たものとして数える", () => {
    const future = new Date(NOW.getTime() + 9 * HOUR);
    // 4 時間前の 1 件と、先の 1 件：4 時間 ÷ 2 件の 3 分の 1 ＝ 40 分
    expect(decideFetchInterval([future, ago(4 * HOUR)], { now: NOW, minMs: MIN })).toBe(
      40 * MINUTE,
    );
    // 先の記事だけなら、下限
    expect(decideFetchInterval([future], { now: NOW, minMs: MIN })).toBe(MIN);
  });
});

describe("currentFetchInterval", () => {
  it("まだ決めていなければ、設定の間隔", () => {
    expect(currentFetchInterval({ fetchIntervalMs: null }, MIN)).toBe(MIN);
  });

  it("決めた間隔を、今の設定の下限と上限に収める", () => {
    expect(currentFetchInterval({ fetchIntervalMs: 3 * HOUR }, MIN)).toBe(3 * HOUR);
    expect(currentFetchInterval({ fetchIntervalMs: 3 * HOUR }, 4 * HOUR)).toBe(4 * HOUR);
    expect(currentFetchInterval({ fetchIntervalMs: 5 * DAY }, MIN)).toBe(DAY);
  });
});

describe("backoffInterval", () => {
  it("フィードの今の間隔を、失敗の回数で倍々に延ばし、上限で止める", () => {
    expect(backoffInterval({ intervalMs: 3 * HOUR, errorCount: 1, minMs: MIN })).toBe(6 * HOUR);
    expect(backoffInterval({ intervalMs: 3 * HOUR, errorCount: 3, minMs: MIN })).toBe(DAY);
    expect(backoffInterval({ intervalMs: MIN, errorCount: 2000, minMs: MIN })).toBe(DAY);
  });
});

describe("retryAfterWait（docs/decisions/jobs.md の 8）", () => {
  it("なければ 0、長すぎれば取得の間隔の上限（1 日）にする", () => {
    expect(retryAfterWait(undefined, MIN)).toBe(0);
    expect(retryAfterWait(2 * HOUR, MIN)).toBe(2 * HOUR);
    expect(retryAfterWait(365 * DAY, MIN)).toBe(DAY);
    expect(MAX_FETCH_INTERVAL_MS).toBe(DAY);
  });

  it("設定の間隔が 1 日より長ければ、設定の間隔まで守る", () => {
    expect(retryAfterWait(365 * DAY, 2 * DAY)).toBe(2 * DAY);
  });
});
