import { ACTIVITY_RETENTION_MS, collectExpiredArticleActivity } from "../db/activity";
import {
  CONTENT_NOTE_GRACE_MS,
  clearUsedContentNotes,
  deleteContentNotes,
  readOldContentNotes,
} from "../db/content";
import { collectRemovals, REMOVAL_RETENTION_MS, raiseRemovalHorizons } from "../db/retention";
import { collectDeletedSavedPages, SAVED_PAGE_REMOVAL_RETENTION_MS } from "../db/saved";
import {
  collectDeletedSettings,
  DELETED_SETTING_RETENTION_MS,
  raiseSettingHorizons,
} from "../db/settings";
import type { Platform } from "../platform";
import { measureExistingContents, reclaimStorage } from "./storage";

/** 同期の削除記録、設定、行のない本文を回収し、容量が圧迫していれば古い記事も片付ける */
/** 1 つの文で消す行の数 */
export const SWEEP_BATCH = 500;

/**
 * 1 回の片付けで、それぞれを消す文の数の上限。受信箱の行は、1 行消すのに 5 行書く（消した記録を
 * 含む）ので少なめにする。合わせて QUERY_BUDGET に収まる
 */
export const SWEEP_ROUNDS = {
  removals: 3,
  settings: 2,
  savedPages: 1,
  activity: 1,
  contents: 2,
} as const;

export type CleanUpOutcome = {
  inbox: number;
  articles: number;
  removals: number;
  settings: number;
  savedPages: number;
  activity: number;
  /** 置き場から消した本文の数 */
  contents: number;
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
  platform: Pick<Platform, "db" | "content" | "now" | "retentionConfig">,
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

  const activity = await repeat(SWEEP_ROUNDS.activity, () =>
    collectExpiredArticleActivity(db, {
      before: new Date(now - ACTIVITY_RETENTION_MS),
      limit: SWEEP_BATCH,
    }),
  );

  // 行のない本文を、書き留めから片付ける（docs/decisions/content.md の 4）。上で消した記事の本文は、
  // トリガーが今書き留めたばかりなので、次の日に片付く
  const contents = await sweepContents(platform, new Date(now - CONTENT_NOTE_GRACE_MS));

  return { inbox, articles, removals, settings, savedPages, activity, contents };
}
