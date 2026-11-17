import { eq, sql } from "drizzle-orm";
import type { Database } from ".";
import { removalHorizons, userArticleRemovals } from "./schema";

/** 同期のために削除記録を残す期間。記事の保存容量とは別 */
export const REMOVAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

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
