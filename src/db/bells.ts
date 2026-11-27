import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { type Database, getRow } from ".";
import { DB_NOW_MS } from "./clock";
import { bellHorizons, bells, feeds, subscriptions } from "./schema";
import { nextSeq } from "./seq";

/*
 * 通知のベル（docs/decisions/notifications.md の 1〜7）。購読だけ、言葉だけ、購読 AND 言葉の 3 つを、
 * 購読と言葉の組で表す。言葉の正規化と当て方は notify/words.ts。
 */

/** 1 人が持てる有効なベルの数 */
export const MAX_BELLS = 100;

/** 外したベルの行を、同期のために残しておく長さ */
export const BELL_REMOVAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** 保存する言葉の形（notify/words.ts の parseBellWords が作る） */
export type BellWords = {
  /** 区切った言葉を半角の空白 1 つでつないだもの。大文字と小文字は入れたまま */
  words: string;
  /** 照合用。言葉を小文字にし、コードポイントの順に並べてつないだもの */
  matchKey: string;
};

/** 付けるベルの組。購読も言葉もないベルは作らない */
export type BellTarget =
  | { feedId: string; words: BellWords | null }
  | { feedId: null; words: BellWords };

/**
 * 有効なベル。REST API、MCP、差分同期で返す形の元。購読のないベルは subscriptionId と feedId が
 * null、言葉のないベルは words が null
 */
export type ActiveBell = {
  id: string;
  subscriptionId: string | null;
  feedId: string | null;
  words: string | null;
  createdAt: Date;
};

export type AddBellResult =
  | { created: boolean; bell: ActiveBell }
  | "feed_not_found"
  | "bell_limit_reached"
  | "bell_id_taken";

/** 付ける文が入らなかったときに、もう一度流す回数（docs/decisions/notifications.md の 3） */
const ADD_ATTEMPTS = 2;

/**
 * その人の有効なベルを、作った順で返す。feedTitle は表示用のフィード名（購読の表示名、フィードの
 * 名前、フィードの URL の順。docs/decisions/mcp.md の 11）。購読のないベルは null
 *
 * 順は変更番号で決める。有効なベルの番号は付けたときに振ったまま変わらない（変わるのは外すときだけ）
 * ので、同じミリ秒に作ったベルどうしでも、作った順と最初の同期の順にそろう
 */
export async function listBells(
  db: Database,
  userId: string,
): Promise<(ActiveBell & { feedTitle: string | null })[]> {
  return db
    .select({
      id: bells.id,
      subscriptionId: bells.subscriptionId,
      feedId: subscriptions.feedId,
      words: bells.words,
      createdAt: bells.createdAt,
      feedTitle: sql<
        string | null
      >`coalesce(${subscriptions.displayName}, ${feeds.title}, ${feeds.url})`,
    })
    .from(bells)
    .leftJoin(subscriptions, eq(subscriptions.id, bells.subscriptionId))
    .leftJoin(feeds, eq(feeds.id, subscriptions.feedId))
    .where(and(eq(bells.userId, userId), isNull(bells.deletedAt)))
    .orderBy(asc(bells.seq))
    .all();
}

/**
 * その人にベルを付ける。feedId があれば、そのフィードの有効な購読に付ける。
 *
 * 購読を引き当てるのも、有効なベルの数を数えるのも、付ける文の中で行う。同じ組（購読と照合用の
 * 言葉）の有効なベルと ID の重なりは、一意索引にぶつけて止める（先に読んで確かめると、同時に付けた
 * 2 つが 2 行になる）。入らなければ、理由を 1 つの文で読み直す。どれにも当たらなければ（読み直す
 * 前に、同じ組のベルが外された）、付ける文をもう一度だけ流す
 */
export async function addBell(
  db: Database,
  input: { userId: string; id: string } & BellTarget,
): Promise<AddBellResult> {
  const { userId, id, feedId } = input;
  const words = input.words?.words ?? null;
  const matchKey = input.words?.matchKey ?? null;
  // 付ける購読。言葉だけのベルは、購読の ID が null の 1 行
  const subscription =
    feedId === null
      ? sql`select null as id`
      : sql`select id from ${subscriptions}
        where user_id = ${userId} and feed_id = ${feedId} and deleted_at is null`;
  for (let attempt = 0; attempt < ADD_ATTEMPTS; attempt++) {
    const inserted = await getRow<{ subscriptionId: string | null; createdAt: number }>(
      db,
      sql`insert into ${bells} (id, user_id, subscription_id, words, match_key, created_at, seq)
      select ${id}, ${userId}, subscription.id, ${words}, ${matchKey}, ${DB_NOW_MS},
        ${nextSeq(bells)}
      from (${subscription}) as subscription
      where (select count(*) from ${bells} as counted
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
          words,
          createdAt: new Date(inserted.createdAt),
        },
      };
    }

    // 同じ組の有効なベルは、一意索引と同じく、null どうしも同じとみなして探す（is で比べる）
    const found = await getRow<{
      subscriptionId: string | null;
      bellId: string | null;
      words: string | null;
      createdAt: number | null;
      full: number;
      idTaken: number;
    }>(
      db,
      sql`with subscription as (${subscription})
      select (select id from subscription) as "subscriptionId",
        existing.id as "bellId", existing.words, existing.created_at as "createdAt",
        (select count(*) from ${bells} where user_id = ${userId} and deleted_at is null)
          >= ${MAX_BELLS} as "full",
        exists (select 1 from ${bells} where id = ${id}) as "idTaken"
      from (select 1)
      left join ${bells} as existing
        on existing.user_id = ${userId} and existing.deleted_at is null
        and existing.subscription_id is (select id from subscription)
        and existing.match_key is ${matchKey}`,
    );
    if (!found) throw new Error("could not read the bell back");
    if (feedId !== null && found.subscriptionId === null) return "feed_not_found";
    if (found.bellId !== null && found.createdAt !== null) {
      return {
        created: false,
        bell: {
          id: found.bellId,
          subscriptionId: found.subscriptionId,
          feedId,
          words: found.words,
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
