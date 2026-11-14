import { and, desc, eq, lt, or, type SQL } from "drizzle-orm";
import type { Database } from ".";
import { type Article, articles, type NewArticle } from "./schema";

/**
 * D1 は1つの文に渡せる変数が 100 個まで。記事は 1 行あたり 9 列なので、
 * 11 行（99 個）ずつに分けて入れる。
 */
const ARTICLE_COLUMNS = 9;
const INSERT_CHUNK = Math.floor(100 / ARTICLE_COLUMNS);

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
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    const chunk = rows.slice(i, i + INSERT_CHUNK);
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
  input: { feedId?: string | undefined; limit: number; cursor?: ArticleCursor | undefined },
): Promise<{ items: Article[]; next: ArticleCursor | null }> {
  const conditions: SQL[] = [];
  if (input.feedId !== undefined) conditions.push(eq(articles.feedId, input.feedId));
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
