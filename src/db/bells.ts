import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { type Database, getRow } from ".";
import { DB_NOW_MS } from "./clock";
import { bellHorizons, bells, feeds, subscriptions } from "./schema";
import { nextSeq } from "./seq";

/*
 * 通知のベル（docs/decisions/notifications.md の 1〜5）。今は購読のベルだけを扱う。
 */

/** 1 人が持てる有効なベルの数 */
export const MAX_BELLS = 100;

/** 外したベルの行を、同期のために残しておく長さ */
export const BELL_REMOVAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** 有効なベル。REST API、MCP、差分同期で返す形の元 */
export type ActiveBell = { id: string; subscriptionId: string; feedId: string; createdAt: Date };

export type AddBellResult =
  | { created: boolean; bell: ActiveBell }
  | "feed_not_found"
  | "bell_limit_reached"
  | "bell_id_taken";

/** 付ける文が入らなかったときに、もう一度流す回数（docs/decisions/notifications.md の 3） */
const ADD_ATTEMPTS = 2;

/**
 * その人の有効なベルを、作った順で返す。feedTitle は表示用のフィード名（購読の表示名、フィードの
 * 名前、フィードの URL の順。docs/decisions/mcp.md の 11）
 */
export async function listBells(
  db: Database,
  userId: string,
): Promise<(ActiveBell & { feedTitle: string })[]> {
  return db
    .select({
      id: bells.id,
      subscriptionId: subscriptions.id,
      feedId: subscriptions.feedId,
      createdAt: bells.createdAt,
      feedTitle: sql<string>`coalesce(${subscriptions.displayName}, ${feeds.title}, ${feeds.url})`,
    })
    .from(bells)
    .innerJoin(subscriptions, eq(subscriptions.id, bells.subscriptionId))
    .innerJoin(feeds, eq(feeds.id, subscriptions.feedId))
    .where(and(eq(bells.userId, userId), isNull(bells.deletedAt)))
    .orderBy(asc(bells.createdAt), asc(bells.id))
    .all();
}

/**
 * その人の、そのフィードの有効な購読にベルを付ける。
 *
 * 購読を引き当てるのも、有効なベルの数を数えるのも、付ける文の中で行う。同じ組の有効なベルと
 * ID の重なりは、一意索引にぶつけて止める（先に読んで確かめると、同時に付けた 2 つが 2 行になる）。
 * 入らなければ、理由を 1 つの文で読み直す。どれにも当たらなければ（読み直す前に、同じ組のベルが
 * 外された）、付ける文をもう一度だけ流す
 */
export async function addBell(
  db: Database,
  input: { userId: string; id: string; feedId: string },
): Promise<AddBellResult> {
  const { userId, id, feedId } = input;
  for (let attempt = 0; attempt < ADD_ATTEMPTS; attempt++) {
    const inserted = await getRow<{ subscriptionId: string; createdAt: number }>(
      db,
      sql`insert into ${bells} (id, user_id, subscription_id, created_at, seq)
      select ${id}, ${userId}, ${subscriptions.id}, ${DB_NOW_MS}, ${nextSeq(bells)}
      from ${subscriptions}
      where ${subscriptions.userId} = ${userId} and ${subscriptions.feedId} = ${feedId}
        and ${subscriptions.deletedAt} is null
        and (select count(*) from ${bells} as counted
          where counted.user_id = ${userId} and counted.deleted_at is null) < ${MAX_BELLS}
      on conflict do nothing
      returning subscription_id as "subscriptionId", created_at as "createdAt"`,
    );
    if (inserted) {
      return {
        created: true,
        bell: {
          id,
          subscriptionId: inserted.subscriptionId,
          feedId,
          createdAt: new Date(inserted.createdAt),
        },
      };
    }

    const found = await getRow<{
      subscriptionId: string | null;
      bellId: string | null;
      createdAt: number | null;
      full: number;
      idTaken: number;
    }>(
      db,
      sql`with subscription as (
        select id from ${subscriptions}
        where user_id = ${userId} and feed_id = ${feedId} and deleted_at is null
      )
      select (select id from subscription) as "subscriptionId",
        existing.id as "bellId", existing.created_at as "createdAt",
        (select count(*) from ${bells} where user_id = ${userId} and deleted_at is null)
          >= ${MAX_BELLS} as "full",
        exists (select 1 from ${bells} where id = ${id}) as "idTaken"
      from (select 1)
      left join ${bells} as existing
        on existing.user_id = ${userId} and existing.deleted_at is null
        and existing.subscription_id = (select id from subscription)`,
    );
    if (!found) throw new Error("could not read the bell back");
    if (found.subscriptionId === null) return "feed_not_found";
    if (found.bellId !== null && found.createdAt !== null) {
      return {
        created: false,
        bell: {
          id: found.bellId,
          subscriptionId: found.subscriptionId,
          feedId,
          createdAt: new Date(found.createdAt),
        },
      };
    }
    if (found.full) return "bell_limit_reached";
    if (found.idTaken) return "bell_id_taken";
  }
  throw new Error("bell was neither added nor found");
}

/**
 * その人のベルを外す。外してあったベルは変えない（変更番号も振らない）。
 *
 * @returns 外したら removed、外してあったら already_removed、その人のベルがなければ not_found
 */
export async function removeBell(
  db: Database,
  input: { userId: string; id: string; now: Date },
): Promise<"removed" | "already_removed" | "not_found"> {
  // 書き込む前の状態を、同じ文の中で読んで返す（db/workspaces.ts の deleteWorkspace と同じ形）
  const row = await getRow<{ removed: number }>(
    db,
    sql`with target as materialized (
      select id, deleted_at is null as active from ${bells}
      where user_id = ${input.userId} and id = ${input.id}
    )
    update ${bells}
    set deleted_at = case when (select active from target)
          then ${input.now.getTime()} else deleted_at end,
        seq = case when (select active from target) then ${nextSeq(bells)} else seq end
    where id = (select id from target)
    returning (select active from target) as removed`,
  );
  if (row === undefined) return "not_found";
  return row.removed ? "removed" : "already_removed";
}

/**
 * 外してから before より前のベルの行を、物理的に消す。消す文の中で、トリガーが変更番号の下限と
 * 人ごとの回収の下限を引き上げる（migrations/0071_bells-triggers.sql）。
 *
 * @returns 消した行の数。limit と同じなら、まだ残っているかもしれない
 */
export async function collectRemovedBells(
  db: Database,
  input: { before: Date; limit: number },
): Promise<number> {
  const rows = await db.all<{ id: string }>(sql`
    delete from ${bells}
    where rowid in (
      select rowid from ${bells}
      where deleted_at < ${input.before.getTime()}
      order by deleted_at limit ${input.limit}
    )
    returning id
  `);
  return rows.length;
}

/** その人のベルの消した印の行を、どこまで回収したか。回収したことがなければ 0 */
export async function readBellHorizon(db: Database, userId: string): Promise<number> {
  const row = await db
    .select({ seq: bellHorizons.seq })
    .from(bellHorizons)
    .where(eq(bellHorizons.userId, userId))
    .get();
  return row?.seq ?? 0;
}
