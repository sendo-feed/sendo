import {
  CONTENT_NOTE_GRACE_MS,
  clearUsedContentNotes,
  deleteContentNotes,
  readOldContentNotes,
} from "../db/content";
import {
  collectRemovals,
  REMOVAL_RETENTION_MS,
  raiseRemovalHorizons,
  sweepExpiredInbox,
  sweepUnsubscribedArticles,
} from "../db/retention";
import {
  collectDeletedSettings,
  DELETED_SETTING_RETENTION_MS,
  raiseSettingHorizons,
} from "../db/settings";
import type { Platform } from "../platform";

/*
 * 1 日 1 回の片付け（docs/decisions/retention.md の 4、5）。定期実行が 1 日 1 回積む。
 *
 * 購読されているフィードの記事は、取得のジョブが片付ける。ここでは、その残り（範囲を過ぎてから
 * スターが外された記事、誰も購読していないフィードの記事）と、受信箱の消した記録、設定の消した印の
 * 行（docs/decisions/settings.md の 3）を片付ける。
 *
 * どれも 1 つの文で消す数に上限を置き、文の数にも上限を置く。残りは次の日に回す。1 日に書く行の
 * 数を抑えるため（D1 の無料枠は 1 日 10 万行で、超えるとその日はすべてのクエリが失敗する）。
 */

/** 1 つの文で消す行の数 */
export const SWEEP_BATCH = 500;

/**
 * 1 回の片付けで、それぞれを消す文の数の上限。受信箱の行は、1 行消すのに 5 行書く（消した記録を
 * 含む）ので少なめにする。合わせて QUERY_BUDGET に収まる
 */
export const SWEEP_ROUNDS = {
  inbox: 2,
  articles: 4,
  removals: 10,
  settings: 2,
  contents: 4,
} as const;

export type CleanUpOutcome = {
  inbox: number;
  articles: number;
  removals: number;
  settings: number;
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
  const expired = new Date(now - platform.retentionConfig.articleMs);

  // 受信箱を先に片付ける。記事は、どの受信箱にも残っていないものだけを消せる
  const inbox = await repeat(SWEEP_ROUNDS.inbox, () =>
    sweepExpiredInbox(db, { before: expired, limit: SWEEP_BATCH }),
  );
  const articles = await repeat(SWEEP_ROUNDS.articles, () =>
    sweepUnsubscribedArticles(db, { before: expired, limit: SWEEP_BATCH }),
  );

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

  // 行のない本文を、書き留めから片付ける（docs/decisions/content.md の 4）。上で消した記事の本文は、
  // トリガーが今書き留めたばかりなので、次の日に片付く
  const contents = await sweepContents(platform, new Date(now - CONTENT_NOTE_GRACE_MS));

  return { inbox, articles, removals, settings, contents };
}
