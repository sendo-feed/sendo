import { eq, sql } from "drizzle-orm";
import type { Database } from ".";
import {
  articles,
  type Feed,
  feeds,
  removalHorizons,
  subscriptions,
  userArticleRemovals,
  userArticles,
} from "./schema";

/*
 * 古い記事の片付け（docs/decisions/retention.md）。
 *
 * スターのない記事は、取り込んでから期間（RetentionConfig）がたったら消す。先に人ごとの受信箱から
 * 消し（行が消えると、トリガーが消した記録を残し、同期で伝わる）、どの受信箱にも残っていない記事を
 * 消す。フィードにまだ載っている記事は、記事の行を残す（消すと、次の取得で新しい記事として入り直す）。
 *
 * - 購読されているフィード：取得のジョブのついでに片付ける（planFeedCleanUp、removeExpiredFromInbox、
 *   deleteExpiredArticles）
 * - それ以外：1 日 1 回の片付けの仕事（jobs/clean-up.ts）が片付ける
 */

const ua = userArticles;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 1 回の取得で、片付けの位置を進めてよい幅（取得の間隔の何倍か）。
 *
 * 片付けの書き込みは、受信箱の行 1 つにつき 5 行と重い。期間を短くしたときなどに、たまった記事を
 * 一度に消すと、D1 の無料枠（1 日 10 万行）を使い切り、その日はすべてのクエリが失敗する。位置を
 * 少しずつ進めれば、1 日に消す量は、そのフィードが 1 日に取り込む量のこの倍数までに収まる。
 * 1 より大きいので、遅れても追いつく
 */
export const CLEAN_UP_CATCH_UP = 2;

/** 受信箱の消した記録を残す期間（docs/decisions/retention.md の 5） */
export const REMOVAL_RETENTION_MS = 30 * DAY_MS;

/**
 * フィードを登録した時刻と、記事を取り込んだ時刻（DB の時計）のずれの許し。片付けの位置を
 * フィードを登録した時刻から始めるとき、これだけ前から始める
 */
const CLOCK_SKEW_MS = 60 * 60 * 1000;

/** 今回の取得で片付ける、記事の取り込み時刻の範囲（from より後、until まで） */
export type CleanUpWindow = { from: Date; until: Date };

/**
 * 今回の取得で片付ける範囲を決める。前回の位置（cleaned_until）から、期限（今から期間を引いた時刻）
 * まで進める。ただし、進める幅は stepMs まで。片付けるものがなければ null
 */
export function planFeedCleanUp(
  feed: Pick<Feed, "cleanedUntil" | "createdAt">,
  input: { now: Date; retentionMs: number; stepMs: number },
): CleanUpWindow | null {
  const from = feed.cleanedUntil ?? new Date(feed.createdAt.getTime() - CLOCK_SKEW_MS);
  const deadline = input.now.getTime() - input.retentionMs;
  const until = Math.min(deadline, from.getTime() + input.stepMs);
  return until > from.getTime() ? { from, until: new Date(until) } : null;
}

/**
 * フィードの記事のうち、取り込み時刻が範囲に入るものを、スターの付いていない受信箱から消す。
 * 何度実行しても同じ結果になる
 */
export async function removeExpiredFromInbox(
  db: Database,
  input: { feedId: string; window: CleanUpWindow },
): Promise<void> {
  await db.run(sql`
    delete from ${ua}
    where ${ua.starredAt} is null
      and ${ua.articleId} in (
        select ${articles.id} from ${articles}
        where ${articles.feedId} = ${input.feedId}
          and ${articles.createdAt} > ${input.window.from.getTime()}
          and ${articles.createdAt} <= ${input.window.until.getTime()}
      )
  `);
}

/**
 * フィードの記事のうち、取り込み時刻が until までで、どの受信箱にも残っておらず、フィードにもう
 * 載っていないものを消す。取得して解析できたときに、そのときフィードに載っていた記事の guid を
 * 渡して呼ぶ。
 *
 * 確かめる条件（受信箱に残っていないか、フィードに載っていないか）は、削除と同じ文の中に入れる。
 * 間にスターが付いたり、購読を始めた人の受信箱に入ったりしても、消さない。
 */
export async function deleteExpiredArticles(
  db: Database,
  input: { feedId: string; until: Date; currentGuids: readonly string[] },
): Promise<void> {
  // guid の数はフィードの記事の数だけあるので、変数の数の上限（100）に触れないよう、JSON の配列
  // 1 つで渡す
  await db.run(sql`
    delete from ${articles}
    where ${articles.feedId} = ${input.feedId}
      and ${articles.createdAt} <= ${input.until.getTime()}
      and not exists (select 1 from ${ua} where ${ua.articleId} = ${articles.id})
      and ${articles.guid} not in (select value from json_each(${JSON.stringify(input.currentGuids)}))
  `);
}

/**
 * 取り込み時刻が before より前の記事を、スターの付いていない受信箱から消す（1 日 1 回の片付け）。
 *
 * 取得のジョブの片付けは、範囲を少しずつ進めるので、範囲を過ぎたあとでスターが外された記事や、
 * 誰も購読していない（取得しない）フィードの記事が残る。それを拾う。
 *
 * @returns 消した行の数。limit と同じなら、まだ残っているかもしれない
 */
export async function sweepExpiredInbox(
  db: Database,
  input: { before: Date; limit: number },
): Promise<number> {
  const rows = await db.all<{ articleId: string }>(sql`
    delete from ${ua}
    where rowid in (
      select ${ua}.rowid from ${ua}
      inner join ${articles} on ${articles.id} = ${ua.articleId}
      where ${ua.starredAt} is null and ${articles.createdAt} < ${input.before.getTime()}
      limit ${input.limit}
    )
    returning ${sql.identifier("article_id")} as "articleId"
  `);
  return rows.length;
}

/**
 * 誰も購読していないフィードの記事のうち、取り込み時刻が before より前で、どの受信箱にも
 * 残っていないものを消す（1 日 1 回の片付け）。取得しないので、フィードに載っているかは見ない。
 * あとで誰かが購読し直すと、フィードに載っている記事は新しい記事として入り直す
 *
 * @returns 消した記事の数。limit と同じなら、まだ残っているかもしれない
 */
export async function sweepUnsubscribedArticles(
  db: Database,
  input: { before: Date; limit: number },
): Promise<number> {
  const rows = await db.all<{ id: string }>(sql`
    delete from ${articles}
    where ${articles.id} in (
      select ${articles.id} from ${articles}
      where ${articles.feedId} in (
          select ${feeds.id} from ${feeds}
          where not exists (
            select 1 from ${subscriptions}
            where ${subscriptions.feedId} = ${feeds.id} and ${subscriptions.deletedAt} is null
          )
        )
        and ${articles.createdAt} < ${input.before.getTime()}
        and not exists (select 1 from ${ua} where ${ua.articleId} = ${articles.id})
      limit ${input.limit}
    )
    returning ${sql.identifier("id")}
  `);
  return rows.length;
}

/**
 * 消えてから REMOVAL_RETENTION_MS より前の、受信箱の消した記録を回収する準備として、人ごとの
 * 回収の下限（removal_horizons）を、その人のその記録の番号の最大まで引き上げる。
 *
 * 消すより先に引き上げる。引き上げたあとで落ちても、下限より古いカーソルが最初から同期し直す
 * だけで済む。消してから引き上げると、その間に来たクライアントが、消えた記録を受け取れない
 */
export async function raiseRemovalHorizons(db: Database, input: { before: Date }): Promise<void> {
  const removals = userArticleRemovals;
  const userId = sql.identifier("user_id");
  const seq = sql.identifier("seq");
  await db.run(sql`
    insert into ${removalHorizons} (${userId}, ${seq})
    select ${removals.userId}, max(${removals.seq}) from ${removals}
    where ${removals.removedAt} < ${input.before.getTime()}
    group by ${removals.userId}
    on conflict (${userId}) do update set ${seq} = max(${removalHorizons.seq}, excluded.${seq})
  `);
}

/**
 * 番号がその人の回収の下限（raiseRemovalHorizons）までの、受信箱の消した記録を消す。
 *
 * @returns 消した記録の数。limit と同じなら、まだ残っているかもしれない
 */
export async function collectRemovals(db: Database, input: { limit: number }): Promise<number> {
  const removals = userArticleRemovals;
  const rows = await db.all<{ articleId: string }>(sql`
    delete from ${removals}
    where rowid in (
      select rowid from ${removals}
      where ${removals.seq} <= (
        select ${removalHorizons.seq} from ${removalHorizons}
        where ${removalHorizons.userId} = ${removals.userId}
      )
      limit ${input.limit}
    )
    returning ${sql.identifier("article_id")} as "articleId"
  `);
  return rows.length;
}

/** その人の受信箱の消した記録を、どこまで回収したか。回収したことがなければ 0 */
export async function readRemovalHorizon(db: Database, userId: string): Promise<number> {
  const row = await db
    .select({ seq: removalHorizons.seq })
    .from(removalHorizons)
    .where(eq(removalHorizons.userId, userId))
    .get();
  return row?.seq ?? 0;
}
