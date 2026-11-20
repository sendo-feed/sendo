import { describe, expect, it } from "vitest";
import { decideFetchInterval, MAX_FETCH_INTERVAL_MS } from "../../src/jobs/fetch-interval";
import {
  decideNextFetch,
  findSlots,
  type PublishedSample,
  SLOT_SAMPLE,
} from "../../src/jobs/fetch-slots";

/*
 * 記事の出る時刻の癖（枠）に合わせた取得の時刻（docs/decisions/jobs.md の 11、#168 の受け入れ条件）。
 * 今は 2026-11-20（金曜）08:00 UTC、設定の間隔（下限）は 30 分。
 */

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MIN = 30 * MINUTE;
const NOW = new Date("2026-11-20T08:00:00Z");
const TODAY = Date.UTC(2026, 10, 20);
/** 40 日前に登録したフィード（見る日数は 28 日） */
const CREATED = new Date(NOW.getTime() - 40 * DAY);

/** daysAgo 日前（0 なら今日）の UTC の hh:mm に出た記事 */
function at(daysAgo: number, hour: number, minute = 0, timeKnown = true): PublishedSample {
  return {
    publishedAt: new Date(TODAY - daysAgo * DAY + hour * HOUR + minute * MINUTE),
    timeKnown,
  };
}

/** 新しい順にそろえる（DB の読み出しと同じ） */
function newestFirst(samples: PublishedSample[]): PublishedSample[] {
  return samples
    .filter((sample) => sample.publishedAt.getTime() <= NOW.getTime())
    .sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());
}

/** DB と同じく、枠の材料（28 日、時刻の分かるもの）とペースの材料（7 日、50 件）を分けて渡す */
function decide(samples: PublishedSample[], options: { now?: Date; created?: Date } = {}) {
  const now = options.now ?? NOW;
  const sorted = newestFirst(samples).filter((s) => s.publishedAt.getTime() <= now.getTime());
  const slotSamples = sorted
    .filter((s) => s.timeKnown && s.publishedAt.getTime() > now.getTime() - 29 * DAY)
    .slice(0, SLOT_SAMPLE);
  const paceSamples = sorted
    .filter((s) => s.publishedAt.getTime() > now.getTime() - 7 * DAY)
    .slice(0, SLOT_SAMPLE);
  const interval = decideNextFetch({
    slotSamples,
    paceSamples,
    now,
    minMs: MIN,
    feedCreatedAt: options.created ?? CREATED,
  });
  return { interval, next: new Date(now.getTime() + interval), paceSamples };
}

/** 7 の決め方（ペース。新しい 50 件）での間隔 */
function paceInterval(paceSamples: PublishedSample[], now = NOW) {
  return decideFetchInterval(
    paceSamples.slice(0, 50).map((s) => s.publishedAt),
    { now, minMs: MIN },
  );
}

/** 0 日前（今日）から days 日前まで、毎日 hours の時刻に 1 件ずつ */
function daily(days: number, hours: number[], minute = 0): PublishedSample[] {
  return Array.from({ length: days + 1 }, (_, daysAgo) =>
    hours.map((hour) => at(daysAgo, hour, minute)),
  ).flat();
}

describe("decideNextFetch（docs/decisions/jobs.md の 11）", () => {
  it("毎日 07:00 なら、今日の分が入っていれば、翌日の 07:00 に取りにいく", () => {
    const samples = daily(28, [7]);
    const { interval, next, paceSamples } = decide(samples);
    expect(next.toISOString()).toBe("2026-11-21T07:00:00.000Z");
    // ペースの決め方（7 日に 7 件で 7 時間ほど）より、取得が少ない
    expect(paceInterval(paceSamples)).toBeLessThan(8 * HOUR);
    expect(interval).toBe(23 * HOUR);
  });

  it("3 時間おき（0・3・…・21 時）なら、8 つの枠が見つかり、次は 09:00", () => {
    const samples = daily(28, [0, 3, 6, 9, 12, 15, 18, 21]);
    expect(findSlots(newestFirst(samples), { now: NOW, feedCreatedAt: CREATED })).toHaveLength(8);
    expect(decide(samples).next.toISOString()).toBe("2026-11-20T09:00:00.000Z");
  });

  it("毎日 07:00・12:00・18:00 なら、次は 12:00", () => {
    expect(decide(daily(28, [7, 12, 18])).next.toISOString()).toBe("2026-11-20T12:00:00.000Z");
  });

  it("平日だけ 07:00 なら、土日の 07:00 には取りにいかない", () => {
    // 2026-11-20 は金曜。土曜（1 日前の逆）・日曜は 0 なので出ない
    const samples = daily(28, [7]).filter((sample) => {
      const weekday = sample.publishedAt.getUTCDay();
      return weekday !== 0 && weekday !== 6;
    });
    const [slot] = findSlots(newestFirst(samples), { now: NOW, feedCreatedAt: CREATED }) ?? [];
    expect(slot?.weekdays).toEqual([1, 2, 3, 4, 5]);
    // 次の枠は月曜の 07:00 だが、枠の外に記事がないので上限（1 日）の土曜 08:00 が先に来る
    const { next } = decide(samples);
    expect(next.toISOString()).toBe("2026-11-21T08:00:00.000Z");
    expect(next.toISOString()).not.toBe("2026-11-21T07:00:00.000Z");
  });

  it("毎日 07:00〜07:20 にばらつくなら、枠は 1 つで、取りにいくのは 07:20", () => {
    const samples = Array.from({ length: 29 }, (_, daysAgo) => at(daysAgo, 7, (daysAgo % 5) * 5));
    const slots = findSlots(newestFirst(samples), { now: NOW, feedCreatedAt: CREATED });
    expect(slots).toHaveLength(1);
    expect(decide(samples).next.toISOString()).toBe("2026-11-21T07:20:00.000Z");
  });

  it("4 割の日だけ 07:00 なら、枠にならず、ペースで決める", () => {
    // 28〜18 日前の 11 日だけ（どの曜日も 4 回のうち 2 回まで）
    const samples = Array.from({ length: 11 }, (_, i) => at(28 - i, 7));
    expect(findSlots(newestFirst(samples), { now: NOW, feedCreatedAt: CREATED })).toEqual([]);
    const { interval, paceSamples } = decide(samples);
    expect(interval).toBe(paceInterval(paceSamples));
  });

  it("07:00 の枠で、その日の記事がまだなければ、設定の間隔のあとに取り直す。1 時間を過ぎたら取り直さない", () => {
    const samples = daily(28, [7]).filter((sample) => sample.publishedAt.getTime() < TODAY);
    const now = (time: string) => new Date(`2026-11-20T${time}:00Z`);
    expect(decide(samples, { now: now("07:20") }).next.toISOString()).toBe(
      "2026-11-20T07:50:00.000Z",
    );
    expect(decide(samples, { now: now("07:50") }).next.toISOString()).toBe(
      "2026-11-20T08:20:00.000Z",
    );
    // 08:00 を過ぎたら取り直さず、翌日の枠を待つ
    expect(decide(samples, { now: now("08:20") }).next.toISOString()).toBe(
      "2026-11-21T07:00:00.000Z",
    );
  });

  it("枠の時刻より前に、その回の記事がもう入っていれば、次の回を待つ", () => {
    // 07:00〜07:20 の枠。今 07:10 に、今日の分（07:05）が入っている
    const samples = Array.from({ length: 29 }, (_, daysAgo) => at(daysAgo, 7, (daysAgo % 5) * 5));
    samples.push(at(0, 7, 5));
    const { next } = decide(samples, { now: new Date("2026-11-20T07:10:00Z") });
    // 今日の 07:20 には取りにいかない。翌日の 07:20 より、上限（1 日）の翌日 07:10 が先に来る
    expect(next.toISOString()).toBe("2026-11-21T07:10:00.000Z");
  });

  it("枠の外にも記事があれば、枠の外のペースで決めた時刻が早ければ、そちらを使う", () => {
    // 毎日 07:00 と、ばらばらの日の 15 時台（直近 7 日に 4 件）
    const offSlot = [at(1, 15, 10), at(2, 15, 40), at(4, 14, 50), at(6, 16, 20)];
    const samples = [...daily(28, [7]), ...offSlot];
    const { interval } = decide(samples);
    const expected = paceInterval(newestFirst(offSlot));
    expect(expected).toBeLessThan(23 * HOUR);
    expect(interval).toBe(expected);
  });

  it("枠に記事がまとまって出ても、枠の外の記事をペースの材料から押し出さない", () => {
    // 毎日 07:00 台に 20 件と、3〜6 日前の午後に枠の外の記事が 4 件
    const burst = Array.from({ length: 29 }, (_, daysAgo) =>
      Array.from({ length: 20 }, (_, i) => at(daysAgo, 7, i)),
    ).flat();
    const offSlot = [at(3, 13, 10), at(4, 15, 40), at(5, 14, 50), at(6, 16, 20)];
    const { interval } = decide([...burst, ...offSlot]);
    expect(interval).toBe(paceInterval(newestFirst(offSlot)));
    expect(interval).toBeLessThan(12 * HOUR);
  });

  it("28 日より前の記事は、700 件に数えない", () => {
    // 直近 28 日は毎日 07:00 に 1 件だけ。28 日と 12 時間前に 672 件
    const old = Array.from({ length: 672 }, (_, i) => ({
      publishedAt: new Date(NOW.getTime() - 28 * DAY - 12 * HOUR + i * 1000),
      timeKnown: true,
    }));
    const samples = newestFirst([...daily(27, [7]), ...old]).slice(0, SLOT_SAMPLE);
    expect(samples).toHaveLength(SLOT_SAMPLE);
    expect(findSlots(samples, { now: NOW, feedCreatedAt: CREATED })).toHaveLength(1);
  });

  it("公開時刻の分からない記事（日付だけ、取り込んだ時刻）は、材料に入らない", () => {
    const samples = Array.from({ length: 29 }, (_, daysAgo) => at(daysAgo, 7, 0, false));
    expect(findSlots(samples, { now: NOW, feedCreatedAt: CREATED })).toEqual([]);
    const { interval, paceSamples } = decide(samples);
    expect(interval).toBe(paceInterval(paceSamples));
  });

  it("登録して 7 日に満たないフィードは、ペースで決める", () => {
    const samples = daily(28, [7]);
    const created = new Date(NOW.getTime() - 6 * DAY);
    expect(findSlots(newestFirst(samples), { now: NOW, feedCreatedAt: created })).toBeNull();
    const { interval, paceSamples } = decide(samples, { created });
    expect(interval).toBe(paceInterval(paceSamples));
  });

  it("28 日に 700 件以上あるフィードは、ペースで決める", () => {
    // 1 時間に 1 件を超えるペース（28 日 × 26 件）
    const samples = Array.from({ length: 28 * 26 }, (_, i) => ({
      publishedAt: new Date(NOW.getTime() - (i + 1) * 55 * MINUTE),
      timeKnown: true,
    }));
    expect(findSlots(newestFirst(samples), { now: NOW, feedCreatedAt: CREATED })).toBeNull();
    const { interval, paceSamples } = decide(samples);
    expect(interval).toBe(paceInterval(paceSamples));
  });

  it("癖が 07:00 から 09:00 に変わると、07:00 の枠が消え、09:00 の枠ができる", () => {
    // 28〜22 日前は 07:00、21 日前から今日までは 09:00
    const samples = Array.from({ length: 29 }, (_, daysAgo) => at(daysAgo, daysAgo >= 22 ? 7 : 9));
    const slots = findSlots(newestFirst(samples), { now: NOW, feedCreatedAt: CREATED });
    expect(slots?.map((slot) => slot.startMs)).toEqual([9 * HOUR]);
    expect(decide(samples).next.toISOString()).toBe("2026-11-20T09:00:00.000Z");
  });

  it("UTC の 0 時をまたぐ枠（23:50〜0:10）も 1 つの枠になる", () => {
    const samples = Array.from({ length: 29 }, (_, daysAgo) =>
      daysAgo % 2 === 0 ? at(daysAgo, 23, 50) : at(daysAgo - 1, 0, 10),
    );
    const slots = findSlots(newestFirst(samples), { now: NOW, feedCreatedAt: CREATED });
    expect(slots).toEqual([
      { startMs: 23 * HOUR + 50 * MINUTE, lastMs: 20 * MINUTE, weekdays: [0, 1, 2, 3, 4, 5, 6] },
    ]);
  });

  it("どの結果も、設定の間隔より短くならず、1 日より長くならない", () => {
    const cases: PublishedSample[][] = [
      daily(28, [7]),
      daily(28, [0, 3, 6, 9, 12, 15, 18, 21]),
      daily(28, [8]), // 今ちょうどの枠
      [],
      [at(10, 7)],
    ];
    for (const samples of cases) {
      for (const minute of [0, 1, 29, 59]) {
        const now = new Date(NOW.getTime() + minute * MINUTE);
        const { interval } = decide(samples, { now });
        expect(interval).toBeGreaterThanOrEqual(MIN);
        expect(interval).toBeLessThanOrEqual(MAX_FETCH_INTERVAL_MS);
      }
    }
  });
});
