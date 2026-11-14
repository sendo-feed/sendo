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
  userArticleRemovals,
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

/**
 * 同期で返す記事。受信箱の行か、受信箱から消えた記録（docs/decisions/sync.md の 3）。
 * クライアントは、消えた記録が届いたときだけ手元の記事を消す
 */
export type SyncArticle = { deleted: false; article: InboxArticle } | { deleted: true; id: string };

export type SyncChanges = {
  folders: Folder[];
  subscriptions: (Subscription & { feed: Feed })[];
  articles: SyncArticle[];
  cursor: SyncCursor;
  hasMore: boolean;
};

/** 1 つの表を読むのに要るもの */
type TableReader<T> = {
  limit: number;
  /** 最初の同期で送る行を、位置より後で upTo まで、(seq, id) の順に limit 件まで読む */
  readInitial: (at: SyncPosition, upTo: number, limit: number) => Promise<T[]>;
  /** 位置より後に変わった行（消した印・消した記録を含む）を、(seq, id) の順に limit 件まで読む */
  readDelta: (at: SyncPosition, limit: number) => Promise<T[]>;
  position: (row: T) => { seq: number; id: string };
  /** そのユーザーの行の最大の番号（消した記録を含む） */
  maxSeq: () => Promise<number>;
};

/** (seq, id) が位置より後か */
function after(seq: AnyColumn, id: AnyColumn, at: SyncPosition): SQL | undefined {
  if (at.id === null) return gt(seq, at.seq);
  return or(gt(seq, at.seq), and(eq(seq, at.seq), gt(id, at.id)));
}

/** 1 つの表だけを読む表の読み方。最初の同期では initialFilter で範囲内の行に絞る */
function singleTable<T>(spec: {
  seq: AnyColumn;
  id: AnyColumn;
  initialFilter: SQL | undefined;
  limit: number;
  /** 条件に合う行を、(seq, id) の順に limit 件まで読む */
  read: (where: SQL | undefined, limit: number) => Promise<T[]>;
  position: (row: T) => { seq: number; id: string };
  maxSeq: () => Promise<number>;
}): TableReader<T> {
  return {
    limit: spec.limit,
    readInitial: (at, upTo, limit) =>
      spec.read(and(after(spec.seq, spec.id, at), lte(spec.seq, upTo), spec.initialFilter), limit),
    readDelta: (at, limit) => spec.read(after(spec.seq, spec.id, at), limit),
    position: spec.position,
    maxSeq: spec.maxSeq,
  };
}

/**
 * (seq, id) の順に比べる。ID は UUID（ASCII）なので、JS の文字列の比べ方が SQLite の比べ方
 * （BINARY）と一致し、SQL の after と同じ順になる
 */
function byPosition(a: { seq: number; id: string }, b: { seq: number; id: string }): number {
  if (a.seq !== b.seq) return a.seq - b.seq;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
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
    const rows = await reader.readDelta(at, reader.limit + 1);
    const items = rows.slice(0, reader.limit);
    const last = items.at(-1);
    return {
      items,
      next: last ? { ...reader.position(last), upTo: null } : at,
      more: rows.length > reader.limit,
    };
  }

  const upTo = at.upTo < 0 ? await reader.maxSeq() : at.upTo;
  const rows = await reader.readInitial(at, upTo, reader.limit + 1);
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
 * - 最初の同期では、消した印の付いた行と消した記録は送らず、記事は未読・スター・直近
 *   INITIAL_SYNC_DAYS 日に受信箱に入ったものに絞る
 * - 差分では、消した印の付いた行も、受信箱から消えた記録も送る（クライアントが手元から消せるように）
 */
export async function readChanges(
  db: Database,
  input: { userId: string; cursor: SyncCursor; now: Date },
): Promise<SyncChanges> {
  const { userId, cursor } = input;
  const ua = userArticles;
  const removals = userArticleRemovals;
  const since = new Date(input.now.getTime() - INITIAL_SYNC_DAYS * 24 * 60 * 60 * 1000);
  const maxSeqOf = async (
    table: typeof folders | typeof subscriptions | typeof ua | typeof removals,
  ) => {
    const row = await db
      .select({ value: max(table.seq) })
      .from(table)
      .where(eq(table.userId, userId))
      .get();
    return row?.value ?? 0;
  };

  const f = await readTable(
    singleTable({
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
    }),
    cursor.folders,
  );

  const s = await readTable(
    singleTable({
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
    }),
    cursor.subscriptions,
  );

  // 記事は、受信箱の行と、受信箱から消えた記録の 2 つの表から読む。番号は同じ並び（消えた記録の
  // 番号は受信箱の表の続きから振る）なので、(seq, id) の順に混ぜれば 1 つの表として送れる
  type ArticleRow = { seq: number; id: string; item: SyncArticle };
  const readInbox = async (where: SQL | undefined, limit: number): Promise<ArticleRow[]> => {
    const rows = await db
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
      .all();
    return rows.map(({ seq, ...article }) => ({
      seq,
      id: article.id,
      item: { deleted: false, article },
    }));
  };
  const readRemovals = async (at: SyncPosition, limit: number): Promise<ArticleRow[]> => {
    const rows = await db
      .select({ id: removals.articleId, seq: removals.seq })
      .from(removals)
      .where(and(eq(removals.userId, userId), after(removals.seq, removals.articleId, at)))
      .orderBy(asc(removals.seq), asc(removals.articleId))
      .limit(limit)
      .all();
    return rows.map(({ id, seq }) => ({ seq, id, item: { deleted: true, id } }));
  };

  const a = await readTable<ArticleRow>(
    {
      limit: SYNC_LIMITS.articles,
      // 最初の同期では、消えた記録は送らない（手元にまだ何もない）
      readInitial: (at, upTo, limit) =>
        readInbox(
          and(
            after(ua.seq, ua.articleId, at),
            lte(ua.seq, upTo),
            or(isNull(ua.readAt), isNotNull(ua.starredAt), gt(ua.createdAt, since)),
          ),
          limit,
        ),
      // それぞれの表から limit 件ずつ読めば、混ぜた先頭の limit 件はそろっている
      readDelta: async (at, limit) => {
        const inbox = await readInbox(after(ua.seq, ua.articleId, at), limit);
        const removed = await readRemovals(at, limit);
        return [...inbox, ...removed].sort(byPosition).slice(0, limit);
      },
      position: (row) => ({ seq: row.seq, id: row.id }),
      maxSeq: async () => Math.max(await maxSeqOf(ua), await maxSeqOf(removals)),
    },
    cursor.articles,
  );

  return {
    folders: f.items,
    subscriptions: s.items.map((row) => ({ ...row.subscription, feed: row.feed })),
    articles: a.items.map((row) => row.item),
    cursor: { folders: f.next, subscriptions: s.next, articles: a.next },
    hasMore: f.more || s.more || a.more,
  };
}
