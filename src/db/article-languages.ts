import { and, eq, sql } from "drizzle-orm";
import { type Database, getRow } from ".";
import { type ArticleLanguage, articleLanguages } from "./schema";

export type LanguageSource = ArticleLanguage["source"];
export interface LanguageCursor {
  articleId: string;
  source: LanguageSource;
}
/** 行と主キー索引を含めた見積もり。容量のトリガーと合わせる */
export const ARTICLE_LANGUAGE_BYTES = 512;

export function getArticleLanguage(db: Database, articleId: string, source: LanguageSource) {
  return db
    .select()
    .from(articleLanguages)
    .where(and(eq(articleLanguages.articleId, articleId), eq(articleLanguages.source, source)))
    .get();
}

/** 存在と版を同じ文で確かめる。遅れて終わった古い仕事は新しい結果を上書きしない */
export async function recordArticleLanguage(
  db: Database,
  input: ArticleLanguage,
): Promise<boolean> {
  const stored = await getRow<{ articleId: string }>(
    db,
    sql`
    insert into article_languages (article_id, source, language, status, score, margin, input_hash, detector, pipeline_revision)
    select ${input.articleId}, ${input.source}, ${input.language}, ${input.status}, ${input.score}, ${input.margin},
      ${input.inputHash}, ${input.detector}, ${input.pipelineRevision}
    where exists (select 1 from articles where id = ${input.articleId})
    on conflict (article_id, source) do update set
      language = excluded.language, status = excluded.status, score = excluded.score, margin = excluded.margin,
      input_hash = excluded.input_hash, detector = excluded.detector, pipeline_revision = excluded.pipeline_revision
    where article_languages.pipeline_revision < excluded.pipeline_revision
    returning article_id as articleId
  `,
  );
  return stored != null;
}

/** 本文を読む前に、未処理の入力元だけを小分けに選ぶ。記事の ID は外へ出さない */
export function findPendingArticleLanguages(
  db: Database,
  revision: number,
  limit: number,
  after?: LanguageCursor,
  /** 指定したら、この記事だけ */
  articleIds?: readonly string[],
) {
  const only = (column: string) =>
    articleIds === undefined
      ? sql``
      : sql`and ${sql.raw(column)} in (${sql.join(
          articleIds.map((id) => sql`${id}`),
          sql`, `,
        )})`;
  return db.all<{ articleId: string; source: LanguageSource }>(sql`
    select articleId, source from (
      select a.id as articleId, case when a.content_key is null then 'metadata' else 'feed' end as source
      from articles a left join article_languages l on l.article_id = a.id
        and l.source = case when a.content_key is null then 'metadata' else 'feed' end
      where (l.pipeline_revision is null or l.pipeline_revision < ${revision}) ${only("a.id")}
      union all
      select a.id as articleId, 'page' as source
      from page_contents p join articles a on a.id = p.article_id
      left join article_languages l on l.article_id = a.id and l.source = 'page'
      where p.status = 'extracted' and p.html is not null
        and (l.pipeline_revision is null or l.pipeline_revision < ${revision}) ${only("a.id")}
    ) where ${after ? sql`(articleId, source) > (${after.articleId}, ${after.source})` : sql`1`}
    order by articleId, source limit ${limit}
  `);
}
