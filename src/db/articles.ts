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

/**
 * 記事をまとめて入れる。同じフィードの同じ guid はすでにあれば飛ばす。
 *
 * 途中で失敗しても、やり直せば残りが入り、入った分は重複しない（冪等）。
 * そのため、トランザクションに頼らずに済む。
 *
 * @returns 新しく入った記事の数
 */
export async function insertArticles(db: Database, rows: readonly ArticleInput[]): Promise<number> {
  let inserted = 0;
  for (const chunk of chunked(rows, articles)) {
    const result = await db
      .insert(articles)
      .values(chunk.map((row) => ({ ...row, createdAt: row.createdAt ?? DB_NOW_MS })))
      .onConflictDoNothing({ target: [articles.feedId, articles.guid] })
      .returning({ id: articles.id })
      .all();
    inserted += result.length;
  }
  return inserted;
}
