import {
  and,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type { Database } from ".";
import { chunked } from "./chunk";
import { type Article, articles, feeds, type NewArticle } from "./schema";

/**
 * 記事をまとめて入れる。同じフィードの同じ guid はすでにあれば飛ばす。
 *
 * 途中で失敗しても、やり直せば残りが入り、入った分は重複しない（冪等）。
 * そのため、トランザクションに頼らずに済む。
 *
 * @returns 新しく入った記事の数
 */
export async function insertArticles(db: Database, rows: readonly NewArticle[]): Promise<number> {
  let inserted = 0;
  for (const chunk of chunked(rows, articles)) {
    const result = await db
      .insert(articles)
      .values(chunk)
      .onConflictDoNothing({ target: [articles.feedId, articles.guid] })
      .returning({ id: articles.id })
      .all();
    inserted += result.length;
  }
  return inserted;
}

/** 一覧で絞り込む記事の状態。all ならすべて */
export type ArticleState = "all" | "unread" | "starred";

/** フォルダに入っているフィードの記事 */
function inFolder(folderId: string): SQL {
  return sql`${articles.feedId} in (select ${feeds.id} from ${feeds} where ${feeds.folderId} = ${folderId})`;
}

/** 一覧のページ送りの位置。直前のページの最後の記事 */
export type ArticleCursor = { publishedAt: number; id: string };

/**
 * 記事を新しい順に返す。
 *
 * OFFSET ではなく、直前のページの最後の記事より古いものを取る（キーセット方式）。
 * 記事が増えても速さが変わらず、ページを送る間に新着が入ってもずれない。
 */
export async function listArticles(
  db: Database,
  input: {
    feedId?: string | undefined;
    folderId?: string | undefined;
    state?: ArticleState | undefined;
    limit: number;
    cursor?: ArticleCursor | undefined;
  },
): Promise<{ items: Article[]; next: ArticleCursor | null }> {
  const conditions: SQL[] = [];
  if (input.feedId !== undefined) conditions.push(eq(articles.feedId, input.feedId));
  if (input.folderId !== undefined) conditions.push(inFolder(input.folderId));
  if (input.state === "unread") conditions.push(isNull(articles.readAt));
  if (input.state === "starred") conditions.push(isNotNull(articles.starredAt));
  if (input.cursor !== undefined) {
    const at = new Date(input.cursor.publishedAt);
    const after = or(
      lt(articles.publishedAt, at),
      and(eq(articles.publishedAt, at), lt(articles.id, input.cursor.id)),
    );
    if (after) conditions.push(after);
  }

  const rows = await db
    .select()
    .from(articles)
    .where(and(...conditions))
    .orderBy(desc(articles.publishedAt), desc(articles.id))
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

/** 既読やスターを変えたい記事 */
export async function getArticle(db: Database, id: string): Promise<Article | undefined> {
  return db.select().from(articles).where(eq(articles.id, id)).get();
}

/**
 * 記事の既読とスターを変える。指定しなかったほうは変えない。
 * すでにその状態なら時刻を変えない（何度送っても同じ結果になる）。
 * @returns 変えたあとの記事。なければ undefined
 */
export async function setArticleState(
  db: Database,
  input: { id: string; read?: boolean | undefined; starred?: boolean | undefined; now: Date },
): Promise<Article | undefined> {
  const set: Partial<Pick<Article, "readAt" | "starredAt">> = {};
  const current = await getArticle(db, input.id);
  if (!current) return undefined;
  if (input.read === true && current.readAt === null) set.readAt = input.now;
  if (input.read === false) set.readAt = null;
  if (input.starred === true && current.starredAt === null) set.starredAt = input.now;
  if (input.starred === false) set.starredAt = null;
  if (Object.keys(set).length === 0) return current;

  return db.update(articles).set(set).where(eq(articles.id, input.id)).returning().get();
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
 * 未読の記事をまとめて既読にする。1 つの UPDATE 文なので、途中までで止まることはない。
 *
 * ID 以外で指定するときは、until までに取り込んだ記事だけを既読にする。一覧を開いた
 * 時刻を渡せば、そのあとに届いた記事は未読のまま残る。
 * @returns 既読にした記事の数
 */
export async function markArticlesRead(
  db: Database,
  input: { scope: MarkReadScope; now: Date },
): Promise<number> {
  const { scope } = input;
  const conditions: SQL[] = [isNull(articles.readAt)];
  if ("ids" in scope) {
    if (scope.ids.length === 0) return 0;
    if (scope.ids.length > MAX_MARK_READ_IDS) {
      throw new RangeError(`at most ${MAX_MARK_READ_IDS} ids`);
    }
    conditions.push(inArray(articles.id, [...scope.ids]));
  } else {
    conditions.push(lte(articles.createdAt, scope.until));
    if ("feedId" in scope) conditions.push(eq(articles.feedId, scope.feedId));
    if ("folderId" in scope) conditions.push(inFolder(scope.folderId));
  }

  const updated = await db
    .update(articles)
    .set({ readAt: input.now })
    .where(and(...conditions))
    .returning({ id: articles.id })
    .all();
  return updated.length;
}

/** フィードごとの未読の数。未読のないフィードは含まない */
export async function countUnreadByFeed(db: Database): Promise<Map<string, number>> {
  const rows = await db
    .select({ feedId: articles.feedId, unread: count() })
    .from(articles)
    .where(isNull(articles.readAt))
    .groupBy(articles.feedId)
    .all();
  return new Map(rows.map((row) => [row.feedId, row.unread]));
}
