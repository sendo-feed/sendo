import { and, desc, eq, gt, isNotNull, isNull, sql } from "drizzle-orm";
import { MAX_ITEMS } from "../fetcher/parse-feed";
import type { Database } from ".";
import { chunked } from "./chunk";
import { DB_NOW_MS } from "./clock";
import { articles, feeds, type NewArticle } from "./schema";

/*
 * 記事は全員で共有し、取り込んだあとは変えない（docs/decisions/sync.md）。
 * 人ごとの既読・スター・一覧は inbox.ts。
 */

/** 記事を入れるときの値。createdAt を省くと、DB の時計で INSERT した時刻になる */
export type ArticleInput = Omit<NewArticle, "createdAt" | "reservedInboxBytes"> & {
  createdAt?: Date;
};

/** アイテムの ID の上限（含まない）。SQLite から JavaScript の数で受け取っても丸められない範囲 */
export const ITEM_ID_LIMIT = 2 ** 53;

/**
 * Google Reader API のアイテムの ID にする、1 以上 2^53 未満の乱数（docs/decisions/greader.md の 3）。
 * 重なる見込みはとても小さいが、重なれば一意の索引で INSERT が失敗し、取得のジョブがやり直す
 * （やり直すときは別の乱数を振る。記事は guid で飛ばすので重複しない）。
 */
export function randomItemId(): number {
  const [high = 0, low = 0] = crypto.getRandomValues(new Uint32Array(2));
  const value = (high & 0x1fffff) * 2 ** 32 + low;
  return value === 0 ? 1 : value;
}

/**
 * 記事をまとめて入れる。同じフィードの同じ guid はすでにあれば飛ばす。
 *
 * 途中で失敗しても、やり直せば残りが入り、入った分は重複しない（冪等）。
 * そのため、トランザクションに頼らずに済む。
 *
 * @returns 新しく入った記事（ID と URL）
 */
export async function insertArticles(
  db: Database,
  rows: readonly ArticleInput[],
): Promise<{ id: string; url: string | null }[]> {
  const inserted: { id: string; url: string | null }[] = [];
  for (const chunk of chunked(rows, articles, 2)) {
    const result = await db
      .insert(articles)
      .values(
        chunk.map((row) => ({
          ...row,
          inCurrentFeed: row.inCurrentFeed === false ? sql`0` : sql`1`,
          reservedInboxBytes: sql`0`,
          createdAt: row.createdAt ?? DB_NOW_MS,
          itemId: row.itemId ?? randomItemId(),
        })),
      )
      .onConflictDoNothing({ target: [articles.feedId, articles.guid] })
      .returning({ id: articles.id, url: articles.url })
      .all();
    inserted.push(...result);
  }
  return inserted;
}

/**
 * Discord の投稿の記事か。Discord の投稿は、置いた本文を全文としても返す（docs/decisions/discord.md の 6）。
 * フィードの discordCursor で見分ける（getArticlePageUrl と同じ）
 */
export async function isDiscordArticle(db: Database, articleId: string): Promise<boolean> {
  const row = await db
    .select({ id: articles.id })
    .from(articles)
    .innerJoin(feeds, eq(articles.feedId, feeds.id))
    .where(and(eq(articles.id, articleId), isNotNull(feeds.discordCursor)))
    .get();
  return row !== undefined;
}

/** ページ抽出の取得先。Discord の投稿は認証が必要なため、Web のページを取りにいかない */
export async function getArticlePageUrl(
  db: Database,
  articleId: string,
): Promise<{ url: string | null } | undefined> {
  return db
    .select({ url: articles.url })
    .from(articles)
    .innerJoin(feeds, eq(articles.feedId, feeds.id))
    .where(and(eq(articles.id, articleId), isNull(feeds.discordCursor)))
    .get();
}

/**
 * フィードの記事のうち、公開日時が since より後のものの公開日時と、その時刻まで分かるかを、新しい順に
 * limit 件まで返す。timeKnownOnly なら、時刻まで分かる記事だけ。取得の時刻を決めるのに使う
 * （docs/decisions/jobs.md の 7、11）。索引（フィード × 公開日時）で引く
 */
export async function recentPublished(
  db: Database,
  input: { feedId: string; since: Date; limit: number; timeKnownOnly?: boolean },
): Promise<{ publishedAt: Date; timeKnown: boolean }[]> {
  const rows = await db
    .select({ publishedAt: articles.publishedAt, timeKnown: articles.publishedTimeKnown })
    .from(articles)
    .where(
      and(
        eq(articles.feedId, input.feedId),
        gt(articles.publishedAt, input.since),
        input.timeKnownOnly ? eq(articles.publishedTimeKnown, true) : undefined,
      ),
    )
    .orderBy(desc(articles.publishedAt))
    .limit(input.limit)
    .all();
  return rows;
}

/** フィードの現在の記事。上限で解析を打ち切った場合には、外れたとは判定しない */
export async function recordCurrentFeed(
  db: Database,
  feedId: string,
  guids: readonly string[],
  parsedCount: number,
): Promise<void> {
  const guidsJson = JSON.stringify(guids);
  // 掲載中だけの索引と guid の索引を使い、何年分の記事があっても履歴全体を読み直さない。
  await db.run(sql`update articles set in_current_feed = (
    guid in (select value from json_each(${guidsJson}))
  ) where id in (
    select id from articles where feed_id = ${feedId} and in_current_feed = 1
      and ${parsedCount < MAX_ITEMS ? 1 : 0} = 1
      and guid not in (select value from json_each(${guidsJson}))
    union all
    select id from articles where feed_id = ${feedId}
      and guid in (select value from json_each(${guidsJson})) and in_current_feed = 0
  )`);
}

/** 集計トリガーと同じ、記事情報の UTF-8 と行・索引の見積もり。本文の予約で先に確保する */
export function estimateArticleBytes(row: ArticleInput): number {
  const encoder = new TextEncoder();
  return (
    2048 +
    [
      row.id,
      row.feedId,
      row.guid,
      row.url,
      row.title,
      row.summary,
      row.author,
      row.thumbnailUrl,
      row.contentKey,
    ].reduce<number>((bytes, value) => bytes + encoder.encode(value ?? "").length, 0)
  );
}
