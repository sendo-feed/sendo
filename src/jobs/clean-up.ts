import {
  collectRemovals,
  REMOVAL_RETENTION_MS,
  raiseRemovalHorizons,
  sweepExpiredInbox,
  sweepUnsubscribedArticles,
} from "../db/retention";
import type { Platform } from "../platform";

/*
 * 1 日 1 回の片付け（docs/decisions/retention.md の 4、5）。定期実行が 1 日 1 回積む。
 *
 * 購読されているフィードの記事は、取得のジョブが片付ける。ここでは、その残り（範囲を過ぎてから
 * スターが外された記事、誰も購読していないフィードの記事）と、受信箱の消した記録を片付ける。
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
export const SWEEP_ROUNDS = { inbox: 2, articles: 4, removals: 10 } as const;

export type CleanUpOutcome = { inbox: number; articles: number; removals: number };

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

export async function runCleanUp(
  platform: Pick<Platform, "db" | "now" | "retentionConfig">,
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

  return { inbox, articles, removals };
}
