import {
  type AnyColumn,
  and,
  asc,
  eq,
  getTableColumns,
  gt,
  isNotNull,
  isNull,
  lte,
  max,
  or,
  type SQL,
} from "drizzle-orm";
import type { Database } from ".";
import type { InboxArticle } from "./inbox";
import {
  articles,
  type Feed,
  type Folder,
  feeds,
  folders,
  type Subscription,
  subscriptions,
  userArticles,
} from "./schema";

/*
 * 差分同期（docs/decisions/sync.md）。人ごとの 3 つの表から、カーソルより後に変わった行を返す。
 */

/**
 * 表ごとの「どこまで送ったか」。
 *
 * - seq と id：最後に送った行。同じ文で変えた行は同じ番号になるので、番号だけだと、ページの
 *   境目でその一部を取りこぼす。ID も組にして、境目で分かれても続きから送れるようにする。
 *   id が null なら、その番号の行はすべて送り終えている
 * - upTo：最初の同期の途中なら、始めたときのその表の最大の番号。最初の同期では、この番号までの
 *   範囲内の行（消した印の付いていない行、未読・スター・直近の記事）だけを送る。ページを送る間に
 *   変わった行はこれより大きい番号になり、差分として届く。null なら差分のモード
 */
export type SyncPosition = { seq: number; id: string | null; upTo: number | null };

export type SyncCursor = {
  folders: SyncPosition;
  subscriptions: SyncPosition;
  articles: SyncPosition;
};

/** 最初の同期の始まり。upTo は、最初のページで決める（-1 は「まだ決めていない」） */
const START: SyncPosition = { seq: 0, id: null, upTo: -1 };

/** カーソルなしで来たとき（最初の同期の始まり） */
export const INITIAL_CURSOR: SyncCursor = {
  folders: START,
  subscriptions: START,
  articles: START,
};

/** 1 回の応答で返す行の数の上限（表ごと） */
export const SYNC_LIMITS = { folders: 500, subscriptions: 500, articles: 300 } as const;

/** 最初の同期で送る、既読の記事の範囲（受信箱に入ってからの日数） */
export const INITIAL_SYNC_DAYS = 30;

export type SyncChanges = {
  folders: Folder[];
  subscriptions: (Subscription & { feed: Feed })[];
  articles: InboxArticle[];
  cursor: SyncCursor;
  hasMore: boolean;
};

/** 1 つの表を読むのに要るもの */
type TableReader<T> = {
  seq: AnyColumn;
  id: AnyColumn;
  /** 最初の同期で送る行だけに絞る条件 */
  initialFilter: SQL | undefined;
  limit: number;
  /** 条件に合う行を、(seq, id) の順に limit 件まで読む */
  read: (where: SQL | undefined, limit: number) => Promise<T[]>;
  position: (row: T) => { seq: number; id: string };
  /** そのユーザーの行の最大の番号 */
  maxSeq: () => Promise<number>;
};

/** (seq, id) が位置より後か */
function after(seq: AnyColumn, id: AnyColumn, at: SyncPosition): SQL | undefined {
  if (at.id === null) return gt(seq, at.seq);
  return or(gt(seq, at.seq), and(eq(seq, at.seq), gt(id, at.id)));
}

/**
 * 1 つの表の、位置より後の行を読む。
 *
 * 最初の同期では、始めたときの最大の番号（upTo）を最初のページで決め、その番号までの範囲内の
 * 行だけを送る。送り終えたら「その番号まですべて済んだ」位置にして、差分のモードに切り替える。
 * 始めたあとに変わった行（すでに送った行が既読になった、消した印が付いたなど）は upTo より大きい
 * 番号になるので、差分として必ず届く。
 */
async function readTable<T>(
  reader: TableReader<T>,
  at: SyncPosition,
): Promise<{ items: T[]; next: SyncPosition; more: boolean }> {
  if (at.upTo === null) {
    const rows = await reader.read(after(reader.seq, reader.id, at), reader.limit + 1);
    const items = rows.slice(0, reader.limit);
    const last = items.at(-1);
    return {
      items,
      next: last ? { ...reader.position(last), upTo: null } : at,
      more: rows.length > reader.limit,
    };
  }

  const upTo = at.upTo < 0 ? await reader.maxSeq() : at.upTo;
  const rows = await reader.read(
    and(after(reader.seq, reader.id, at), lte(reader.seq, upTo), reader.initialFilter),
    reader.limit + 1,
  );
  const items = rows.slice(0, reader.limit);
  const last = items.at(-1);
  if (rows.length > reader.limit && last) {
    return { items, next: { ...reader.position(last), upTo }, more: true };
  }
  // 最初の同期を送り終えた。始めたあとに変わった行があれば、続けて差分を取ってもらう
  // （hasMore を false で返すと、クライアントは次に開くまでその変更を受け取らない）
  const changedSince = (await reader.maxSeq()) > upTo;
  return { items, next: { seq: upTo, id: null, upTo: null }, more: changedSince };
}

/**
 * カーソルより後に変わった、そのユーザーのフォルダ・購読・受信箱の行を返す。
 *
 * - 最初の同期では、消した印の付いた行は送らず、記事は未読・スター・直近 INITIAL_SYNC_DAYS 日に
 *   受信箱に入ったものに絞る
 * - 差分では、消した印の付いた行も送る（クライアントが手元から消せるように）
 */
export async function readChanges(
  db: Database,
  input: { userId: string; cursor: SyncCursor; now: Date },
): Promise<SyncChanges> {
  const { userId, cursor } = input;
  const ua = userArticles;
  const since = new Date(input.now.getTime() - INITIAL_SYNC_DAYS * 24 * 60 * 60 * 1000);
  const maxSeqOf = async (table: typeof folders | typeof subscriptions | typeof ua) => {
    const row = await db
      .select({ value: max(table.seq) })
      .from(table)
      .where(eq(table.userId, userId))
      .get();
    return row?.value ?? 0;
  };

  const f = await readTable(
    {
      seq: folders.seq,
      id: folders.id,
      initialFilter: isNull(folders.deletedAt),
      limit: SYNC_LIMITS.folders,
      read: (where, limit) =>
        db
          .select()
          .from(folders)
          .where(and(eq(folders.userId, userId), where))
          .orderBy(asc(folders.seq), asc(folders.id))
          .limit(limit)
          .all(),
      position: (row) => ({ seq: row.seq, id: row.id }),
      maxSeq: () => maxSeqOf(folders),
    },
    cursor.folders,
  );

  const s = await readTable(
    {
      seq: subscriptions.seq,
      id: subscriptions.id,
      initialFilter: isNull(subscriptions.deletedAt),
      limit: SYNC_LIMITS.subscriptions,
      read: (where, limit) =>
        db
          .select({ subscription: subscriptions, feed: feeds })
          .from(subscriptions)
          .innerJoin(feeds, eq(subscriptions.feedId, feeds.id))
          .where(and(eq(subscriptions.userId, userId), where))
          .orderBy(asc(subscriptions.seq), asc(subscriptions.id))
          .limit(limit)
          .all(),
      position: (row) => ({ seq: row.subscription.seq, id: row.subscription.id }),
      maxSeq: () => maxSeqOf(subscriptions),
    },
    cursor.subscriptions,
  );

  const a = await readTable(
    {
      seq: ua.seq,
      id: ua.articleId,
      initialFilter: or(isNull(ua.readAt), isNotNull(ua.starredAt), gt(ua.createdAt, since)),
      limit: SYNC_LIMITS.articles,
      read: (where, limit) =>
        db
          .select({
            ...getTableColumns(articles),
            readAt: ua.readAt,
            starredAt: ua.starredAt,
            receivedAt: ua.createdAt,
            seq: ua.seq,
          })
          .from(ua)
          .innerJoin(articles, eq(articles.id, ua.articleId))
          .where(and(eq(ua.userId, userId), where))
          .orderBy(asc(ua.seq), asc(ua.articleId))
          .limit(limit)
          .all(),
      position: (row) => ({ seq: row.seq, id: row.id }),
      maxSeq: () => maxSeqOf(ua),
    },
    cursor.articles,
  );

  return {
    folders: f.items,
    subscriptions: s.items.map((row) => ({ ...row.subscription, feed: row.feed })),
    articles: a.items.map(({ seq: _seq, ...article }) => article),
    cursor: { folders: f.next, subscriptions: s.next, articles: a.next },
    hasMore: f.more || s.more || a.more,
  };
}
