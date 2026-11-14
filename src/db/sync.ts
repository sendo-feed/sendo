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
  notExists,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
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
 * - done：この位置を返したページで、この表の変更を送り切ったか（続く行がなかった）。まとめて既読の
 *   境界に使えるのは、送り切った位置だけ（docs/decisions/sync.md の 6）。送り切っていない位置では、
 *   受信箱に入ったときの番号が境界より前でも、番号が後ろへ動いてまだ届いていない記事がありうる
 */
export type SyncPosition = { seq: number; id: string | null; upTo: number | null; done: boolean };

export type SyncCursor = {
  folders: SyncPosition;
  subscriptions: SyncPosition;
  articles: SyncPosition;
};

/** 最初の同期の始まり。upTo は、最初のページで決める（-1 は「まだ決めていない」） */
const START: SyncPosition = { seq: 0, id: null, upTo: -1, done: false };

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
  /** 差分で送る行だけに絞る条件（なければすべて） */
  deltaFilter?: SQL | undefined;
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
    readDelta: (at, limit) => spec.read(and(after(spec.seq, spec.id, at), spec.deltaFilter), limit),
    position: spec.position,
    maxSeq: spec.maxSeq,
  };
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
    const more = rows.length > reader.limit;
    return {
      items,
      next: last ? { ...reader.position(last), upTo: null, done: !more } : { ...at, done: true },
      more,
    };
  }

  const upTo = at.upTo < 0 ? await reader.maxSeq() : at.upTo;
  const rows = await reader.readInitial(at, upTo, reader.limit + 1);
  const items = rows.slice(0, reader.limit);
  const last = items.at(-1);
  if (rows.length > reader.limit && last) {
    return { items, next: { ...reader.position(last), upTo, done: false }, more: true };
  }
  // 最初の同期を送り終えた。始めたあとに変わった行があれば、続けて差分を取ってもらう
  // （hasMore を false で返すと、クライアントは次に開くまでその変更を受け取らない）
  const changedSince = (await reader.maxSeq()) > upTo;
  return {
    items,
    next: { seq: upTo, id: null, upTo: null, done: !changedSince },
    more: changedSince,
  };
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
  const maxSeqOf = async (table: typeof folders | typeof subscriptions) => {
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

  const current = alias(subscriptions, "current");
  const s = await readTable(
    singleTable({
      seq: subscriptions.seq,
      id: subscriptions.id,
      initialFilter: isNull(subscriptions.deletedAt),
      // API では購読をフィードの ID で返すので、購読し直したフィードには、やめた古い行と今の行の
      // 2 つが同じ ID で並ぶ。今の行があるのに古い行の「消した」を送ると、クライアントから今の購読が
      // 消える。古い行の番号があとから進んでも食い違わないよう、今の行があれば古い行は送らない
      deltaFilter: or(
        isNull(subscriptions.deletedAt),
        notExists(
          db
            .select({ one: sql`1` })
            .from(current)
            .where(
              and(
                eq(current.userId, userId),
                eq(current.feedId, subscriptions.feedId),
                isNull(current.deletedAt),
              ),
            ),
        ),
      ),
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

  /** 最初の同期：受信箱の行のうち、手元に置く範囲（未読・スター・直近）だけを読む */
  const readInitialArticles = async (
    at: SyncPosition,
    upTo: number,
    limit: number,
  ): Promise<ArticleRow[]> => {
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
      .where(
        and(
          eq(ua.userId, userId),
          after(ua.seq, ua.articleId, at),
          lte(ua.seq, upTo),
          or(isNull(ua.readAt), isNotNull(ua.starredAt), gt(ua.createdAt, since)),
        ),
      )
      .orderBy(asc(ua.seq), asc(ua.articleId))
      .limit(limit)
      .all();
    return rows.map(({ seq, ...article }) => ({
      seq,
      id: article.id,
      item: { deleted: false, article },
    }));
  };

  /**
   * 差分：位置より後に変わった受信箱の行と、消えた記録を、混ぜて (seq, id) の順に読む。
   *
   * 2 つの表は必ず 1 つの文で読む（D1 は文ごとに、ある時点の状態を読む）。別々の文で読むと、その
   * 間に入った新着が、あとから入った消えた記録より小さい番号のまま取り残され、カーソルがその先へ
   * 進んで取りこぼす（#25 のレビュー）。
   */
  const readArticleChanges = async (at: SyncPosition, limit: number): Promise<ArticleRow[]> => {
    const c = sql.identifier("changes");
    const col = (name: string) => sql`${c}.${sql.identifier(name)}`;
    // それぞれの表から limit 件ずつ読めば、混ぜた先頭の limit 件はそろっている
    const branch = (table: typeof ua | typeof removals, removed: 0 | 1) => sql`
      select * from (
        select ${table.seq} as seq, ${table.articleId} as article_id,
          ${sql.raw(String(removed))} as removed
        from ${table}
        where ${table.userId} = ${userId} and ${after(table.seq, table.articleId, at)}
        order by ${table.seq}, ${table.articleId}
        limit ${limit}
      )`;
    const rows = await db
      .select({
        seq: sql<number>`${col("seq")}`,
        changedId: sql<string>`${col("article_id")}`,
        removed: sql<number>`${col("removed")}`,
        ...getTableColumns(articles),
        readAt: ua.readAt,
        starredAt: ua.starredAt,
        receivedAt: ua.createdAt,
      })
      .from(sql`(${branch(ua, 0)} union all ${branch(removals, 1)}) as ${c}`)
      .leftJoin(
        ua,
        and(
          sql`${col("removed")} = 0`,
          eq(ua.userId, userId),
          eq(ua.articleId, sql`${col("article_id")}`),
        ),
      )
      .leftJoin(
        articles,
        and(sql`${col("removed")} = 0`, eq(articles.id, sql`${col("article_id")}`)),
      )
      .orderBy(asc(col("seq")), asc(col("article_id")))
      .limit(limit)
      .all();

    return rows.map((row): ArticleRow => {
      const { seq, changedId: id } = row;
      if (row.removed) return { seq, id, item: { deleted: true, id } };
      // 同じ文で読むので、受信箱の行には必ず受信箱の状態と記事がある（外部キー）
      const { feedId, guid, publishedAt, createdAt, receivedAt } = row;
      if (
        feedId === null ||
        guid === null ||
        publishedAt === null ||
        createdAt === null ||
        receivedAt === null
      ) {
        throw new Error(`inbox row without its article: ${id}`);
      }
      const article: InboxArticle = {
        id,
        feedId,
        guid,
        url: row.url,
        title: row.title,
        summary: row.summary,
        author: row.author,
        publishedAt,
        createdAt,
        readAt: row.readAt,
        starredAt: row.starredAt,
        receivedAt,
      };
      return { seq, id, item: { deleted: false, article } };
    });
  };

  const a = await readTable<ArticleRow>(
    {
      limit: SYNC_LIMITS.articles,
      // 最初の同期では、消えた記録は送らない（手元にまだ何もない）
      readInitial: readInitialArticles,
      readDelta: readArticleChanges,
      position: (row) => ({ seq: row.seq, id: row.id }),
      // 受信箱の行と消えた記録の両方の最大を、1 つの文で読む
      maxSeq: async () => {
        const row = await db.get<{ value: number }>(sql`select max(
          coalesce((select max(${ua.seq}) from ${ua} where ${ua.userId} = ${userId}), 0),
          coalesce((select max(${removals.seq}) from ${removals} where ${removals.userId} = ${userId}), 0)
        ) as value`);
        return row?.value ?? 0;
      },
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
