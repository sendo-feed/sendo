import { sql } from "drizzle-orm";
import type { Database } from ".";

/**
 * 取り込んだ記事のフィードのカテゴリを、1 つの文でまとめて入れる（docs/decisions/article-analysis.md の 8）。
 * 記事があることを同じ文で確かめる。もう入っている位置は変えない（やり直しても同じ結果）。上限を超える
 * 行は、容量のトリガーが入れない
 */
export async function insertArticleCategories(
  db: Database,
  articles: readonly { articleId: string; categories: readonly string[] }[],
): Promise<void> {
  const rows = articles.flatMap(({ articleId, categories }) =>
    categories.map((name, position) => ({ articleId, position, name })),
  );
  if (rows.length === 0) return;
  await db.run(sql`
    insert into article_categories (article_id, position, name)
    select json_extract(value, '$.articleId'), json_extract(value, '$.position'),
      json_extract(value, '$.name')
    from json_each(${JSON.stringify(rows)})
    where exists (select 1 from articles where id = json_extract(value, '$.articleId'))
    on conflict do nothing
  `);
}

/** 記事のフィードのカテゴリを、フィードに出てきた順で返す */
export async function readArticleCategories(db: Database, articleId: string): Promise<string[]> {
  const rows = await db.all<{ name: string }>(sql`
    select name from article_categories where article_id = ${articleId} order by position
  `);
  return rows.map((row) => row.name);
}
