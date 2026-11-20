import type { Database } from "../db";
import { recentPublished } from "../db/articles";
import {
  decideFetchInterval,
  maxFetchInterval,
  PACE_SAMPLE,
  PACE_WINDOW_MS,
} from "./fetch-interval";

/*
 * 記事の出る時刻の癖（枠）に合わせた取得の時刻（docs/decisions/jobs.md の 11）。
 *
 * 公開時刻の分かる記事から、UTC の 1 日の中の時刻のまとまり（30 分の幅）を探し、曜日ごとに
 * 6 割以上の日に記事があれば枠とする。枠はどこにも保存せず、取得のたびに記事から求め直す。
 * 決め方は DB に触らない関数（decideNextFetch）にし、記事の読み出しは nextFetchInterval が行う。
 */

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

/** 枠を探すのに見る日数の上限 */
export const SLOT_WINDOW_DAYS = 28;
/** 枠を探すのに使う記事の数の上限。これに達したら（1 時間に 1 件を超えるペース）、枠は探さない */
export const SLOT_SAMPLE = 700;
/** 見る日数がこれに満たなければ、枠は探さない */
export const SLOT_MIN_DAYS = 7;
/** 枠の幅 */
export const SLOT_WIDTH_MS = 30 * MINUTE;
/** 枠とみなす、同じ曜日のうち記事のある日の割合 */
export const SLOT_RATIO = 0.6;
/** 枠とみなすのに要る、記事のある日の数 */
export const SLOT_MIN_HIT_DAYS = 3;
/** 枠の時刻を過ぎても記事がなければ、取り直す期間（枠のいちばん遅い時刻から） */
export const SLOT_RETRY_MS = 60 * MINUTE;

/** 記事の公開日時と、その時刻まで分かるか */
export type PublishedSample = { publishedAt: Date; timeKnown: boolean };

/**
 * 枠。startMs は UTC の 1 日の始まりから枠の始まりまでの長さ、lastMs は枠の始まりから、枠の中で
 * いちばん遅い公開時刻までの長さ。weekdays は、枠を使う UTC の曜日（0 が日曜。枠の始まりの日で数える）
 */
export type FetchSlot = { startMs: number; lastMs: number; weekdays: readonly number[] };

type Point = { at: number; minuteOfDay: number };

/** UTC の日の番号（1970-01-01 からの日数）の曜日。1970-01-01 は木曜 */
function weekdayOf(day: number): number {
  return (((day + 4) % 7) + 7) % 7;
}

/** start から見て、1 日の中の時刻 minuteOfDay がどれだけ後か（日をまたいでも 0 以上 1 日未満） */
function offsetFrom(start: number, minuteOfDay: number): number {
  return (minuteOfDay - start + DAY) % DAY;
}

/** 公開時刻 at が、start から始まる枠に入るとき、その枠の始まりの日の番号 */
function slotDayOf(at: number, start: number): number {
  return Math.floor((at - offsetFrom(start, at % DAY)) / DAY);
}

/**
 * 記事の公開時刻から、枠を探す。
 *
 * - 材料は、公開時刻の分かる記事だけ
 * - 見る日数は 28 日と、フィードを登録してからの日数の短いほう。今日（UTC）は、まだ終わっていない
 *   ので数えない
 * - 材料が 700 件に達したとき、見る日数が 7 日に満たないときは、枠を探さない（null）
 * - 30 分の幅に入る記事のまとまりのうち、6 割以上の日に記事のある曜日があり、記事のある日が
 *   3 日以上あるものを枠にする。記事のある日の多いまとまりから順に採り、採ったまとまりの記事は
 *   次のまとまりに使わない
 */
export function findSlots(
  samples: readonly PublishedSample[],
  input: { now: Date; feedCreatedAt: Date },
): FetchSlot[] | null {
  const known = samples.filter((sample) => sample.timeKnown);
  if (known.length >= SLOT_SAMPLE) return null;

  const now = input.now.getTime();
  const today = Math.floor(now / DAY);
  const observedDays = Math.min(
    SLOT_WINDOW_DAYS,
    Math.floor((now - input.feedCreatedAt.getTime()) / DAY),
  );
  if (observedDays < SLOT_MIN_DAYS) return null;
  const firstDay = today - observedDays;

  // 見る日の中で、曜日ごとに何日あるか
  const occurrences = new Array<number>(7).fill(0);
  for (let day = firstDay; day < today; day++) {
    const weekday = weekdayOf(day);
    occurrences[weekday] = (occurrences[weekday] ?? 0) + 1;
  }

  // 日をまたぐ枠（UTC 23:50〜0:10 など）のために、見る日の前の日の終わりと、今日の初めの記事も材料に入れる。
  // どの日に数えるかは、枠の始まりの日で決める（evaluate）
  let points: Point[] = known
    .map((sample) => sample.publishedAt.getTime())
    .filter((at) => at >= firstDay * DAY - SLOT_WIDTH_MS && at <= now)
    .map((at) => ({ at, minuteOfDay: at % DAY }))
    .sort((a, b) => a.minuteOfDay - b.minuteOfDay || a.at - b.at);

  const slots: FetchSlot[] = [];
  for (;;) {
    let best: { slot: FetchSlot; score: number; members: Set<Point> } | undefined;
    for (let i = 0; i < points.length; i++) {
      const start = (points[i] as Point).minuteOfDay;
      if (i > 0 && (points[i - 1] as Point).minuteOfDay === start) continue;
      const candidate = evaluate(points, i, { firstDay, today, occurrences });
      if (candidate === undefined) continue;
      if (best === undefined || candidate.score > best.score) best = candidate;
    }
    if (best === undefined) break;
    slots.push(best.slot);
    const members = best.members;
    points = points.filter((point) => !members.has(point));
  }
  return slots.sort((a, b) => a.startMs - b.startMs);
}

/** points[i] の時刻から始まる 30 分の幅のまとまりを、枠として使えるか確かめる */
function evaluate(
  points: readonly Point[],
  i: number,
  input: { firstDay: number; today: number; occurrences: readonly number[] },
): { slot: FetchSlot; score: number; members: Set<Point> } | undefined {
  const start = (points[i] as Point).minuteOfDay;
  const members = new Set<Point>();
  const days = new Map<number, number>(); // 日の番号 → その日の記事の、枠の始まりからのいちばん遅い長さ
  for (let k = 0; k < points.length; k++) {
    const point = points[(i + k) % points.length] as Point;
    const offset = offsetFrom(start, point.minuteOfDay);
    if (offset > SLOT_WIDTH_MS) break;
    members.add(point);
    const day = slotDayOf(point.at, start);
    if (day < input.firstDay || day >= input.today) continue;
    days.set(day, Math.max(days.get(day) ?? 0, offset));
  }

  const hitsByWeekday = new Array<number>(7).fill(0);
  for (const day of days.keys()) {
    const weekday = weekdayOf(day);
    hitsByWeekday[weekday] = (hitsByWeekday[weekday] ?? 0) + 1;
  }
  const weekdays = hitsByWeekday.flatMap((hits, weekday) => {
    const occurrences = input.occurrences[weekday] ?? 0;
    return occurrences > 0 && hits / occurrences >= SLOT_RATIO ? [weekday] : [];
  });
  if (weekdays.length === 0 || days.size < SLOT_MIN_HIT_DAYS) return undefined;

  // 枠を使う曜日の記事だけで、いちばん遅い時刻と点数を決める（ほかの曜日の外れた記事に引きずられない）
  let lastMs = 0;
  let score = 0;
  for (const [day, offset] of days) {
    if (!weekdays.includes(weekdayOf(day))) continue;
    lastMs = Math.max(lastMs, offset);
    score++;
  }
  return { slot: { startMs: start, lastMs, weekdays }, score, members };
}

/** 公開時刻 at が、どれかの枠（その曜日に使うもの）の幅に入るか */
function inSlot(slots: readonly FetchSlot[], at: number): boolean {
  return slots.some((slot) => {
    if (offsetFrom(slot.startMs, at % DAY) > SLOT_WIDTH_MS) return false;
    return slot.weekdays.includes(weekdayOf(slotDayOf(at, slot.startMs)));
  });
}

/**
 * 次に取りにいくまでの長さを決める（docs/decisions/jobs.md の 11）。
 *
 * 枠がなければ（探さない場合を含む）、記事の出るペースから決める（7）。枠があれば、次のうち
 * いちばん早い時刻にする。下限は設定の間隔、上限は 7 と同じ。
 *
 * - 次の枠の、いちばん遅い時刻。その回の記事がもう入っていれば、その次の回
 * - 枠に入らない記事だけから、7 と同じ決め方で求めた時刻
 * - 直前の枠のいちばん遅い時刻から 1 時間の間で、その回の記事がまだなければ、設定の間隔のあと
 *
 * @param slotSamples 直近 28 日の、公開時刻の分かる記事（新しい順に 700 件まで）
 * @param paceSamples 7 の決め方の材料（直近 7 日の記事、新しい順に 50 件まで）
 */
export function decideNextFetch(input: {
  slotSamples: readonly PublishedSample[];
  paceSamples: readonly PublishedSample[];
  now: Date;
  minMs: number;
  feedCreatedAt: Date;
}): number {
  const { now: nowDate, minMs } = input;
  const slots = findSlots(input.slotSamples, { now: nowDate, feedCreatedAt: input.feedCreatedAt });
  if (slots === null || slots.length === 0) {
    return decideFetchInterval(
      input.paceSamples.map((sample) => sample.publishedAt),
      { now: nowDate, minMs },
    );
  }

  const now = nowDate.getTime();
  const today = Math.floor(now / DAY);
  const known = input.slotSamples
    .filter((sample) => sample.timeKnown)
    .map((sample) => sample.publishedAt.getTime());
  const hasArticle = (from: number, to: number) => known.some((at) => at >= from && at <= to);

  const candidates: number[] = [];

  // 枠の外の記事のペース。枠の外に記事がなければ、上限になる
  const offSlot = input.paceSamples.filter(
    (sample) => !sample.timeKnown || !inSlot(slots, sample.publishedAt.getTime()),
  );
  candidates.push(
    now +
      decideFetchInterval(
        offSlot.map((sample) => sample.publishedAt),
        { now: nowDate, minMs },
      ),
  );

  for (const slot of slots) {
    // 直前の回と、次の回（8 日先まで見れば、どの曜日の枠も 1 回は来る）
    for (let day = today - 1; day <= today + 8; day++) {
      if (!slot.weekdays.includes(weekdayOf(day))) continue;
      const startsAt = day * DAY + slot.startMs;
      const lastAt = startsAt + slot.lastMs;
      if (lastAt <= now) {
        // 遅れて出る記事を拾う
        if (now < lastAt + SLOT_RETRY_MS && !hasArticle(startsAt, now)) {
          candidates.push(now + minMs);
        }
        continue;
      }
      // その回の記事がもう入っていれば、その次の回を待つ
      if (hasArticle(startsAt, startsAt + SLOT_WIDTH_MS)) continue;
      candidates.push(lastAt);
      break;
    }
  }

  const next = Math.min(...candidates);
  return Math.min(Math.max(next - now, minMs), maxFetchInterval(minMs));
}

/**
 * フィードの記事を DB から読んで、次に取りにいくまでの長さを決め直す（docs/decisions/jobs.md の 7、11）。
 * 取得に成功するたびに（304 を含む）呼ぶ
 */
export async function nextFetchInterval(
  db: Database,
  input: { feedId: string; now: Date; minMs: number; feedCreatedAt: Date },
): Promise<number> {
  const now = input.now.getTime();
  const [slotSamples, paceSamples] = await Promise.all([
    recentPublished(db, {
      feedId: input.feedId,
      since: new Date(now - (SLOT_WINDOW_DAYS + 1) * DAY),
      limit: SLOT_SAMPLE,
      timeKnownOnly: true,
    }),
    recentPublished(db, {
      feedId: input.feedId,
      since: new Date(now - PACE_WINDOW_MS),
      limit: PACE_SAMPLE,
    }),
  ]);
  return decideNextFetch({
    slotSamples,
    paceSamples,
    now: input.now,
    minMs: input.minMs,
    feedCreatedAt: input.feedCreatedAt,
  });
}
