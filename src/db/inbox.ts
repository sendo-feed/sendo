import {
  and,
  count,
  desc,
  eq,
  getTableColumns,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type { Database } from ".";
import { chunked } from "./chunk";
import { DB_NOW_MS, dbNow } from "./clock";
import { type Article, articles, feeds, subscriptions, userArticles } from "./schema";
import { nextSeq } from "./seq";

/*
 * ユーザーの受信箱（user_articles）。購読しているフィードの記事が人ごとに 1 行ずつ入り、
 * 既読・スター・変更番号を持つ（docs/decisions/accounts.md、sync.md）。
 */

/** 受信箱の記事。共有の記事の本体と、その人の既読・スター */
export type InboxArticle = Article & {
  readAt: Date | null;
  starredAt: Date | null;
  /** 受信箱に入った時刻（DB の時計） */
  receivedAt: Date;
};

/** 購読を始めたときに、受信箱に入れる記事の範囲 */
export const BACKFILL_PER_FEED = 50;
export const BACKFILL_DAYS = 30;

const ua = userArticles;

/** 列の名前を、INSERT の列の並びに書く形にする */
const columns = (...names: string[]) =>
  sql.join(
    names.map((name) => sql.identifier(name)),
    sql`, `,
  );

const INBOX_COLUMNS = columns(
  "user_id",
  "article_id",
  "feed_id",
  "published_at",
  "created_at",
  "seq",
);

/**
 * フィードの新しい記事を、購読している人の受信箱に配る。取得のジョブが記事を入れたあとに呼ぶ。
 *
 * どこまで配ったかをフィードに記録し（delivered_until）、次はその続きから配る。配るのが途中で
 * 落ちても、記録を進める前なので、次の取得で配り直せる（同じ行は飛ばす）。
 * 今（DB の時計）と同じミリ秒の記事まで配り、記録は 1 ミリ秒前までにする。同じミリ秒に
 * ほかの取得が入れた記事は、次に配り直す（同じ行は飛ばす）。
 */
export async function deliverNewArticles(db: Database, input: { feedId: string }): Promise<void> {
  const upTo = (await dbNow(db)).getTime();
  await db.run(sql`
    insert into ${ua} (${INBOX_COLUMNS})
    select ${subscriptions.userId}, ${articles.id}, ${articles.feedId}, ${articles.publishedAt},
      ${DB_NOW_MS}, ${nextSeq(ua)}
    from ${articles}
    inner join ${subscriptions}
      on ${subscriptions.feedId} = ${articles.feedId} and ${subscriptions.deletedAt} is null
    where ${articles.feedId} = ${input.feedId}
      and ${articles.createdAt} > coalesce(
        (select ${feeds.deliveredUntil} from ${feeds} where ${feeds.id} = ${input.feedId}), -1)
      and ${articles.createdAt} <= ${upTo}
    on conflict do nothing
  `);
  await db
    .update(feeds)
    .set({
      deliveredUntil: sql`max(coalesce(${feeds.deliveredUntil}, -1), ${upTo - 1})`,
    })
    .where(eq(feeds.id, input.feedId))
    .run();
}

/**
 * 購読を始めた人の受信箱に、すでに取り込んであった最近の記事を入れる。フィードごとに、
 * 直近 BACKFILL_DAYS 日の新しい順に BACKFILL_PER_FEED 件まで。
 *
 * 入れ終えたら購読に印（backfilled_at）を付ける。印のない購読だけを対象にするので、
 * 入れる途中で落ちても、もう一度呼べば入る（同じ行は飛ばす）。新しく作ったばかりのフィード
 * には記事がまだないので、印が付くだけになる。
 */
export async function backfillInbox(
  db: Database,
  input: { userId: string; feedIds: readonly string[]; now: Date },
): Promise<void> {
  const since = input.now.getTime() - BACKFILL_DAYS * 24 * 60 * 60 * 1000;
  for (const chunk of chunked(input.feedIds, null)) {
    const pending = await db
      .select({ id: subscriptions.id, feedId: subscriptions.feedId })
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.userId, input.userId),
          inArray(subscriptions.feedId, chunk),
          isNull(subscriptions.deletedAt),
          isNull(subscriptions.backfilledAt),
        ),
      )
      .all();
    if (pending.length === 0) continue;

    await insertRecentArticles(db, {
      userId: input.userId,
      feedIds: pending.map((row) => row.feedId),
      since,
    });
    await markBackfilled(db, {
      subscriptionIds: pending.map((row) => row.id),
      now: input.now,
    });
  }
}

/**
 * 補充済みの印を、補充の対象にした購読（ID）にだけ付ける。ユーザーとフィードで付けると、
 * 補充の途中で購読をやめてもう一度購読した場合に、補充していない新しい購読に印が付き、
 * 二度と補充されなくなる。
 */
export async function markBackfilled(
  db: Database,
  input: { subscriptionIds: readonly string[]; now: Date },
): Promise<void> {
  for (const chunk of chunked(input.subscriptionIds, null)) {
    await db
      .update(subscriptions)
      .set({ backfilledAt: input.now })
      .where(inArray(subscriptions.id, chunk))
      .run();
  }
}

/**
 * フィードの最近の記事を、ユーザーの受信箱に入れる（backfillInbox の中身）。
 *
 * 購読がまだ有効かを、INSERT と同じ文の中で確かめる。先に確かめてから入れると、その間に
 * 購読をやめて受信箱を掃除された場合に、やめた購読の記事を入れ直してしまう。
 */
export async function insertRecentArticles(
  db: Database,
  input: { userId: string; feedIds: readonly string[]; since: number },
): Promise<void> {
  if (input.feedIds.length === 0) return;
  const ids = sql.join(
    input.feedIds.map((id) => sql`${id}`),
    sql`, `,
  );
  const recent = sql.identifier("recent");
  const col = (name: string) => sql`${recent}.${sql.identifier(name)}`;
  await db.run(sql`
    insert into ${ua} (${INBOX_COLUMNS})
    select ${input.userId}, ${col("id")}, ${col("feed_id")}, ${col("published_at")},
      ${DB_NOW_MS}, ${nextSeq(ua)}
    from (
      select ${articles.id}, ${articles.feedId}, ${articles.publishedAt},
        row_number() over (
          partition by ${articles.feedId}
          order by ${articles.publishedAt} desc, ${articles.id} desc
        ) as ${sql.identifier("rank")}
      from ${articles}
      where ${articles.feedId} in (${ids}) and ${articles.publishedAt} >= ${input.since}
    ) as ${recent}
    where ${col("rank")} <= ${BACKFILL_PER_FEED}
      and exists (
        select 1 from ${subscriptions}
        where ${subscriptions.userId} = ${input.userId}
          and ${subscriptions.feedId} = ${col("feed_id")}
          and ${subscriptions.deletedAt} is null
      )
    on conflict do nothing
  `);
}

/** 一覧で絞り込む記事の状態。all ならすべて */
export type ArticleState = "all" | "unread" | "starred";

/** 一覧のページ送りの位置。直前のページの最後の記事 */
export type ArticleCursor = { publishedAt: number; id: string };

/** そのユーザーの、フォルダに入っている購読のフィードの記事 */
function inFolder(userId: string, folderId: string): SQL {
  return sql`${ua.feedId} in (
    select ${subscriptions.feedId} from ${subscriptions}
    where ${subscriptions.userId} = ${userId}
      and ${subscriptions.folderId} = ${folderId}
      and ${subscriptions.deletedAt} is null
  )`;
}

const inboxSelection = {
  ...getTableColumns(articles),
  readAt: ua.readAt,
  starredAt: ua.starredAt,
  receivedAt: ua.createdAt,
};

/**
 * 受信箱の記事を新しい順に返す。
 *
 * OFFSET ではなく、直前のページの最後の記事より古いものを取る（キーセット方式）。
 * 記事が増えても速さが変わらず、ページを送る間に新着が入ってもずれない。
 */
export async function listInbox(
  db: Database,
  input: {
    userId: string;
    feedId?: string | undefined;
    folderId?: string | undefined;
    state?: ArticleState | undefined;
    limit: number;
    cursor?: ArticleCursor | undefined;
  },
): Promise<{ items: InboxArticle[]; next: ArticleCursor | null }> {
  const conditions: SQL[] = [eq(ua.userId, input.userId)];
  if (input.feedId !== undefined) conditions.push(eq(ua.feedId, input.feedId));
  if (input.folderId !== undefined) conditions.push(inFolder(input.userId, input.folderId));
  if (input.state === "unread") conditions.push(isNull(ua.readAt));
  if (input.state === "starred") conditions.push(isNotNull(ua.starredAt));
  if (input.cursor !== undefined) {
    const at = new Date(input.cursor.publishedAt);
    const after = or(
      lt(ua.publishedAt, at),
      and(eq(ua.publishedAt, at), lt(ua.articleId, input.cursor.id)),
    );
    if (after) conditions.push(after);
  }

  const rows = await db
    .select(inboxSelection)
    .from(ua)
    .innerJoin(articles, eq(articles.id, ua.articleId))
    .where(and(...conditions))
    .orderBy(desc(ua.publishedAt), desc(ua.articleId))
    .limit(input.limit + 1)
    .all();

  const items = rows.slice(0, input.limit);
  const last = items.at(-1);
  const next =
    rows.length > input.limit && last
      ? { publishedAt: last.publishedAt.getTime(), id: last.id }
      : null;
  return { items, next };
}

/** 受信箱の記事を 1 件。その人の受信箱になければ undefined */
export async function getInboxArticle(
  db: Database,
  input: { userId: string; articleId: string },
): Promise<InboxArticle | undefined> {
  return db
    .select(inboxSelection)
    .from(ua)
    .innerJoin(articles, eq(articles.id, ua.articleId))
    .where(and(eq(ua.userId, input.userId), eq(ua.articleId, input.articleId)))
    .get();
}

/**
 * 記事の既読とスターを変える。指定しなかったほうは変えない。
 *
 * すでにその状態なら時刻を変えない。先に読んでから書くと、同時に届いた 2 つの「既読」が
 * どちらも未読を見て後の時刻で上書きするので、UPDATE の中で coalesce して残す。
 * @returns 変えたあとの記事。その人の受信箱になければ undefined
 */
export async function setArticleState(
  db: Database,
  input: {
    userId: string;
    articleId: string;
    read?: boolean | undefined;
    starred?: boolean | undefined;
    now: Date;
  },
): Promise<InboxArticle | undefined> {
  const now = input.now.getTime();
  const set: { readAt?: SQL | null; starredAt?: SQL | null; seq?: SQL } = {};
  if (input.read !== undefined) {
    set.readAt = input.read ? sql`coalesce(${ua.readAt}, ${now})` : null;
  }
  if (input.starred !== undefined) {
    set.starredAt = input.starred ? sql`coalesce(${ua.starredAt}, ${now})` : null;
  }
  if (Object.keys(set).length > 0) {
    set.seq = nextSeq(ua);
    const updated = await db
      .update(ua)
      .set(set)
      .where(and(eq(ua.userId, input.userId), eq(ua.articleId, input.articleId)))
      .returning({ articleId: ua.articleId })
      .get();
    if (!updated) return undefined;
  }
  return getInboxArticle(db, { userId: input.userId, articleId: input.articleId });
}

/** まとめて既読にする範囲 */
export type MarkReadScope =
  | { ids: readonly string[] }
  | { feedId: string; until: Date }
  | { folderId: string; until: Date }
  | { all: true; until: Date };

/** IN 句に並べられる記事の ID の数。D1 の変数の上限（100）から、ほかの条件の分を残す */
export const MAX_MARK_READ_IDS = 90;

/**
 * 受信箱の未読の記事をまとめて既読にする。1 つの UPDATE 文なので、途中までで止まることはない。
 *
 * ID 以外で指定するときは、until より前に受信箱に入った記事だけを既読にする。一覧の応答の
 * asOf（DB の時計）を渡せば、一覧に出ていなかった記事は未読のまま残る。
 * @returns 既読にした記事の数
 */
export async function markArticlesRead(
  db: Database,
  input: { userId: string; scope: MarkReadScope; now: Date },
): Promise<number> {
  const { scope } = input;
  const conditions: SQL[] = [eq(ua.userId, input.userId), isNull(ua.readAt)];
  if ("ids" in scope) {
    if (scope.ids.length === 0) return 0;
    if (scope.ids.length > MAX_MARK_READ_IDS) {
      throw new RangeError(`at most ${MAX_MARK_READ_IDS} ids`);
    }
    conditions.push(inArray(ua.articleId, [...scope.ids]));
  } else {
    // 境界と同じミリ秒の記事は、未読のまま残す側に倒す
    conditions.push(lt(ua.createdAt, scope.until));
    if ("feedId" in scope) conditions.push(eq(ua.feedId, scope.feedId));
    if ("folderId" in scope) conditions.push(inFolder(input.userId, scope.folderId));
  }

  const updated = await db
    .update(ua)
    .set({ readAt: input.now, seq: nextSeq(ua) })
    .where(and(...conditions))
    .returning({ id: ua.articleId })
    .all();
  return updated.length;
}

/** フィードごとの未読の数。未読のないフィードは含まない */
export async function countUnreadByFeed(
  db: Database,
  userId: string,
): Promise<Map<string, number>> {
  const rows = await db
    .select({ feedId: ua.feedId, unread: count() })
    .from(ua)
    .where(and(eq(ua.userId, userId), isNull(ua.readAt)))
    .groupBy(ua.feedId)
    .all();
  return new Map(rows.map((row) => [row.feedId, row.unread]));
}
