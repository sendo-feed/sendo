import { ACTIVITY_RETENTION_MS, collectExpiredArticleActivity } from "../db/activity";
import { collectStaleCandidates, STALE_CANDIDATE_GRACE_MS } from "../db/article-analyses";
import { collectOldBellNotifications } from "../db/bell-notifications";
import { BELL_REMOVAL_RETENTION_MS, collectRemovedBells } from "../db/bells";
import {
  CONTENT_NOTE_GRACE_MS,
  clearUsedContentNotes,
  deleteContentNotes,
  readOldContentNotes,
} from "../db/content";
import { collectExpiredPushRegistrations } from "../db/push-registrations";
import { collectRemovals, REMOVAL_RETENTION_MS, raiseRemovalHorizons } from "../db/retention";
import { collectDeletedSavedPages, SAVED_PAGE_REMOVAL_RETENTION_MS } from "../db/saved";
import {
  collectDeletedSettings,
  DELETED_SETTING_RETENTION_MS,
  raiseSettingHorizons,
} from "../db/settings";
import { collectRemovedTags, TAG_REMOVAL_RETENTION_MS } from "../db/tags";
import type { Platform } from "../platform";
import { measureExistingContents, reclaimStorage } from "./storage";

/** 同期の削除記録、設定、行のない本文を回収し、容量が圧迫していれば古い記事も片付ける */
/** 1 つの文で消す行の数 */
export const SWEEP_BATCH = 500;

/**
 * 1 回の片付けで、それぞれを消す文の数の上限。受信箱の行は、1 行消すのに 5 行書く（消した記録を
 * 含む）ので少なめにする。1 つの仕事が扱う量を抑え、残りは翌日に回す（docs/decisions/jobs.md の 4）。
 * 通知の行だけは、残りを続きの仕事に回す（sweepBellNotifications）
 */
export const SWEEP_ROUNDS = {
  removals: 3,
  settings: 2,
  savedPages: 1,
  bells: 1,
  tags: 1,
  activity: 1,
  pushRegistrations: 1,
  bellNotifications: 4,
  contents: 2,
  candidates: 2,
} as const;

export type CleanUpOutcome = {
  inbox: number;
  articles: number;
  removals: number;
  settings: number;
  savedPages: number;
  bells: number;
  /** 消してから 30 日たったタグの行 */
  tags: number;
  activity: number;
  /** 期限の切れたセッションの Web Push の登録 */
  pushRegistrations: number;
  /** 作ってから 1 日たったベルの通知の行 */
  bellNotifications: number;
  /** 置き場から消した本文の数 */
  contents: number;
  /** 解析の行の世代と合わない、作ってから 1 日たった候補の行 */
  candidates: number;
};

/** 消し切るか、文の数の上限に届くまで、消すのを繰り返す */
async function repeat(rounds: number, step: () => Promise<number>): Promise<number> {
  let total = 0;
  for (let round = 0; round < rounds; round++) {
    const removed = await step();
    total += removed;
    if (removed < SWEEP_BATCH) break;
  }
  return total;
}

/**
 * 作ってから 1 日たった通知の行を消す（docs/decisions/notifications.md の 10）。行は取得の仕事ごとに
 * できるので、残りを翌日に回すと流入に追いつかないことがある。最後の文まで満杯に消したら、まだ残って
 * いるかもしれないので、通知の行だけを消す続きの仕事を積む。続きの仕事も同じように続け、満杯でない
 * 文が出たら止まる
 *
 * @returns 消した行の数
 */
export async function sweepBellNotifications(
  platform: Pick<Platform, "db" | "jobs">,
): Promise<number> {
  const removed = await repeat(SWEEP_ROUNDS.bellNotifications, () =>
    collectOldBellNotifications(platform.db, { limit: SWEEP_BATCH }),
  );
  if (removed === SWEEP_ROUNDS.bellNotifications * SWEEP_BATCH) {
    await platform.jobs.enqueue([{ type: "clean-up-bell-notifications" }]);
  }
  return removed;
}

/**
 * before より前の書き留めを見て、どの記事の行にも入っていない名前の本文を置き場から消し、
 * 書き留めを消す。行に入っている名前は、書き留めだけを消す（行がまだあるかは、消す文の中で
 * 確かめ直す）。
 *
 * 本文を消してから、書き留めを消す。間で落ちても、書き留めが残っているので、次の片付けで
 * もう一度消す（ない本文を消しても、何も起きない）
 *
 * @returns 置き場から消した本文の数
 */
async function sweepContents(
  platform: Pick<Platform, "db" | "content">,
  before: Date,
): Promise<number> {
  let removed = 0;
  for (let round = 0; round < SWEEP_ROUNDS.contents; round++) {
    const notes = await readOldContentNotes(platform.db, { before, limit: SWEEP_BATCH });
    const unused = notes.filter((note) => !note.used).map((note) => note.key);
    await platform.content.delete(unused);
    await deleteContentNotes(platform.db, unused);
    // 行に入っていた名前は、消す文の中で、行がまだあるかを確かめ直す。読んだあとで記事が消えると、
    // トリガーは書き留めがもうあるので何も足さない。ここで確かめずに消すと、その本文を消す
    // 手掛かりがなくなる。行がなくなっていれば書き留めは残り、次の片付けで本文を消す
    await clearUsedContentNotes(
      platform.db,
      notes.filter((note) => note.used).map((note) => note.key),
    );
    removed += unused.length;
    if (notes.length < SWEEP_BATCH) break;
  }
  return removed;
}

export async function runCleanUp(
  platform: Pick<Platform, "db" | "content" | "jobs" | "now" | "retentionConfig">,
): Promise<CleanUpOutcome> {
  const { db } = platform;
  const now = platform.now().getTime();
  await measureExistingContents(platform);
  const { inbox, articles } = await reclaimStorage(platform);

  // 回収の下限を先に引き上げてから、消した記録を消す
  await raiseRemovalHorizons(db, { before: new Date(now - REMOVAL_RETENTION_MS) });
  const removals = await repeat(SWEEP_ROUNDS.removals, () =>
    collectRemovals(db, { limit: SWEEP_BATCH }),
  );

  // 設定の消した印の行も、回収の下限を先に引き上げてから消す
  await raiseSettingHorizons(db, { before: new Date(now - DELETED_SETTING_RETENTION_MS) });
  const settings = await repeat(SWEEP_ROUNDS.settings, () =>
    collectDeletedSettings(db, { limit: SWEEP_BATCH }),
  );

  const savedPages = await repeat(SWEEP_ROUNDS.savedPages, () =>
    collectDeletedSavedPages(db, {
      before: new Date(now - SAVED_PAGE_REMOVAL_RETENTION_MS),
      limit: SWEEP_BATCH,
    }),
  );

  const bells = await repeat(SWEEP_ROUNDS.bells, () =>
    collectRemovedBells(db, {
      before: new Date(now - BELL_REMOVAL_RETENTION_MS),
      limit: SWEEP_BATCH,
    }),
  );

  // 消したタグの行（docs/decisions/tags.md の 7）。消す文の中でトリガーが回収の下限を記録する
  const tagRows = await repeat(SWEEP_ROUNDS.tags, () =>
    collectRemovedTags(db, {
      before: new Date(now - TAG_REMOVAL_RETENTION_MS),
      limit: SWEEP_BATCH,
    }),
  );

  const activity = await repeat(SWEEP_ROUNDS.activity, () =>
    collectExpiredArticleActivity(db, {
      before: new Date(now - ACTIVITY_RETENTION_MS),
      limit: SWEEP_BATCH,
    }),
  );

  // 期限の切れたセッションの端末には送らない（docs/decisions/web-push.md の 4）
  const pushRegistrations = await repeat(SWEEP_ROUNDS.pushRegistrations, () =>
    collectExpiredPushRegistrations(db, { now: new Date(now), limit: SWEEP_BATCH }),
  );

  // 窓と上限を数え終えた通知の行。消しきれなければ、続きの仕事を積む
  const bellNotifications = await sweepBellNotifications(platform);

  // 行のない本文を、書き留めから片付ける（docs/decisions/content.md の 4）。上で消した記事の本文は、
  // トリガーが今書き留めたばかりなので、次の日に片付く
  const contents = await sweepContents(platform, new Date(now - CONTENT_NOTE_GRACE_MS));

  // 印を書く前に落ちた解析や、重なって負けた解析の候補の行（docs/decisions/article-analysis.md の 5）
  const candidates = await repeat(SWEEP_ROUNDS.candidates, () =>
    collectStaleCandidates(db, {
      before: new Date(now - STALE_CANDIDATE_GRACE_MS),
      limit: SWEEP_BATCH,
    }),
  );

  return {
    inbox,
    articles,
    removals,
    settings,
    savedPages,
    bells,
    tags: tagRows,
    activity,
    pushRegistrations,
    bellNotifications,
    contents,
    candidates,
  };
}
