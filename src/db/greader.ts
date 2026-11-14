import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  max,
  or,
  type SQL,
} from "drizzle-orm";
import type { Database } from ".";
import { chunked } from "./chunk";
import { type InboxArticle, inFolder } from "./inbox";
import { articles, feeds, userArticles } from "./schema";

/*
 * Google Reader API 向けの読み書き（docs/decisions/greader.md）。記事をアイテムの ID
 * （articles.item_id）で引く。人ごとのデータなので、必ずユーザーで絞る。
 * 既読・スターの変え方は inbox.ts の setArticleState と同じ決まりにする。
 */

const ua = userArticles;

/** ストリームの絞り込み */
export type StreamFilter = {
  feedId?: string | undefined;
  folderId?: string | undefined;
  /** この状態の記事だけ */
  only?: "read" | "starred" | undefined;
  /** この状態の記事を除く */
  exclude?: readonly ("read" | "starred")[] | undefined;
};

/** ストリームのページ送りの位置。直前のページの最後の記事 */
export type StreamPosition = { publishedAt: number; articleId: string };

/** ストリームに並ぶ記事の参照 */
export type StreamItemRef = { itemId: number; publishedAt: Date; receivedAt: Date };

/**
 * ストリームの記事を、公開日時の順（newest：新しい順、oldest：古い順）に返す。
 * receivedSince（含む）／ receivedBefore（含まない）は、受信箱に入った時刻で絞る（リーダーアプリが
 * 「前回から新しく入った記事」を取るのに使う。公開日時で絞ると、あとから入った古い記事を取りこぼす）。
 * 始まりを含めるのは、前回の取得を始めた秒に入った記事を取りこぼさないため（重なっても害はない）。
 */
export async function listStreamItems(
  db: Database,
  input: {
    userId: string;
    filter: StreamFilter;
    receivedSince?: Date | undefined;
    receivedBefore?: Date | undefined;
    order: "newest" | "oldest";
    limit: number;
    after?: StreamPosition | undefined;
  },
): Promise<{ items: StreamItemRef[]; next: StreamPosition | null }> {
  const { filter } = input;
  const conditions: (SQL | undefined)[] = [eq(ua.userId, input.userId)];
  if (filter.feedId !== undefined) conditions.push(eq(ua.feedId, filter.feedId));
  if (filter.folderId !== undefined) conditions.push(inFolder(input.userId, filter.folderId));
  if (filter.only === "read") conditions.push(isNotNull(ua.readAt));
  if (filter.only === "starred") conditions.push(isNotNull(ua.starredAt));
  if (filter.exclude?.includes("read")) conditions.push(isNull(ua.readAt));
  if (filter.exclude?.includes("starred")) conditions.push(isNull(ua.starredAt));
  if (input.receivedSince) conditions.push(gte(ua.createdAt, input.receivedSince));
  if (input.receivedBefore) conditions.push(lt(ua.createdAt, input.receivedBefore));
  const beyond = input.order === "newest" ? lt : gt;
  if (input.after) {
    const at = new Date(input.after.publishedAt);
    conditions.push(
      or(
        beyond(ua.publishedAt, at),
        and(eq(ua.publishedAt, at), beyond(ua.articleId, input.after.articleId)),
      ),
    );
  }
  const direction = input.order === "newest" ? desc : asc;

  const rows = await db
    .select({
      articleId: ua.articleId,
      itemId: articles.itemId,
      publishedAt: ua.publishedAt,
      receivedAt: ua.createdAt,
    })
    .from(ua)
    .innerJoin(articles, eq(articles.id, ua.articleId))
    .where(and(...conditions))
    .orderBy(direction(ua.publishedAt), direction(ua.articleId))
    .limit(input.limit + 1)
    .all();

  const page = rows.slice(0, input.limit);
  const last = page.at(-1);
  return {
    items: page.map(({ itemId, publishedAt, receivedAt }) => ({ itemId, publishedAt, receivedAt })),
    next:
      rows.length > input.limit && last
        ? { publishedAt: last.publishedAt.getTime(), articleId: last.articleId }
        : null,
  };
}

/** Google Reader API で返す記事。受信箱の記事に、アイテムの ID とフィードの名前を足したもの */
export type ReaderItem = InboxArticle & {
  itemId: number;
  feedTitle: string | null;
  feedSiteUrl: string | null;
  feedUrl: string;
};

/** その人の受信箱にある記事を、アイテムの ID で引く（ない ID は飛ばす） */
export async function getItemsByItemIds(
  db: Database,
  input: { userId: string; itemIds: readonly number[] },
): Promise<ReaderItem[]> {
  const items: ReaderItem[] = [];
  for (const chunk of chunked(input.itemIds, null)) {
    const rows = await db
      .select({
        ...getTableColumns(articles),
        readAt: ua.readAt,
        starredAt: ua.starredAt,
        receivedAt: ua.createdAt,
        feedTitle: feeds.title,
        feedSiteUrl: feeds.siteUrl,
        feedUrl: feeds.url,
      })
      .from(ua)
      .innerJoin(articles, eq(articles.id, ua.articleId))
      .innerJoin(feeds, eq(feeds.id, ua.feedId))
      .where(and(eq(ua.userId, input.userId), inArray(articles.itemId, chunk)))
      .all();
    items.push(...rows);
  }
  return items;
}

/** フィードごとの未読の数と、未読のうちいちばん新しく受信箱に入った時刻。未読のないフィードは含まない */
export async function countUnreadWithNewest(
  db: Database,
  userId: string,
): Promise<{ feedId: string; count: number; newestReceivedAt: Date | null }[]> {
  return db
    .select({ feedId: ua.feedId, count: count(), newestReceivedAt: max(ua.createdAt) })
    .from(ua)
    .where(and(eq(ua.userId, userId), isNull(ua.readAt)))
    .groupBy(ua.feedId)
    .all();
}
