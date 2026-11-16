import { eq } from "drizzle-orm";
import type { Database } from ".";
import { chunked } from "./chunk";
import { DB_NOW_MS } from "./clock";
import { articles, type NewArticle } from "./schema";

/*
 * 記事は全員で共有し、取り込んだあとは変えない（docs/decisions/sync.md）。
 * 人ごとの既読・スター・一覧は inbox.ts。
 */

/** 記事を入れるときの値。createdAt を省くと、DB の時計で INSERT した時刻になる */
export type ArticleInput = Omit<NewArticle, "createdAt"> & { createdAt?: Date };

/** アイテムの ID の上限（含まない）。D1 から JavaScript の数で受け取っても丸められない範囲 */
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
  for (const chunk of chunked(rows, articles)) {
    const result = await db
      .insert(articles)
      .values(
        chunk.map((row) => ({
          ...row,
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

/** 記事の URL を引く。記事がなければ undefined */
export async function getArticleUrl(
  db: Database,
  articleId: string,
): Promise<{ url: string | null } | undefined> {
  return db.select({ url: articles.url }).from(articles).where(eq(articles.id, articleId)).get();
}
