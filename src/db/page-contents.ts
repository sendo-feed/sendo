/**
 * 記事のページから抜いた本文の行（docs/decisions/content.md の 13、14）。全員で共有する。
 * サニタイズした本文の HTML を、行に入れる（置き場には置かない）。
 */
import { eq, sql } from "drizzle-orm";
import type { Database } from ".";
import { type PageContent, pageContents } from "./schema";

/** 抜けなかった記事を、開いたときに取りにいき直すまで待つ時間（決定の 14） */
export const PAGE_CONTENT_RETRY_MS = 24 * 60 * 60 * 1000;

export async function getPageContent(
  db: Database,
  articleId: string,
): Promise<PageContent | undefined> {
  return db.select().from(pageContents).where(eq(pageContents.articleId, articleId)).get();
}

/**
 * 抜けた本文を記録する。まだ抜けた行がなければ書き、すでにあれば（ほかの抜き取りが先に終わった）
 * 何も変えない。確かめるのは、書く文の中で行う（決定の 13）。
 *
 * 記事がまだあるかも、同じ文の中で確かめる。抜いている間に記事が片付けられていたら、何も書かない
 * （外部キーの違反にしない）
 *
 * @returns 行に入っている本文。先に抜けた行があれば、その本文。記事がなければ null
 */
export async function recordExtractedPageContent(
  db: Database,
  input: { articleId: string; html: string; now: Date },
): Promise<string | null> {
  await db.run(sql`
    insert into page_contents (article_id, status, html, attempted_at)
    select ${input.articleId}, 'extracted', ${input.html}, ${input.now.getTime()}
    where exists (select 1 from articles where articles.id = ${input.articleId})
    on conflict (article_id) do update set
      status = excluded.status,
      html = excluded.html,
      attempted_at = excluded.attempted_at
    -- 抜けなかった記録だけを上書きする。抜けた行は、あとから変えない
    where page_contents.status = 'failed'
  `);
  const row = await getPageContent(db, input.articleId);
  return row?.status === "extracted" ? row.html : null;
}

/**
 * 抜けなかったことを記録する。抜けた行があれば、何も変えない（ほかの抜き取りが先に終わった）。
 * 記事がもうなければ、何も書かない
 */
export async function recordFailedPageContent(
  db: Database,
  input: { articleId: string; now: Date },
): Promise<void> {
  await db.run(sql`
    insert into page_contents (article_id, status, html, attempted_at)
    select ${input.articleId}, 'failed', null, ${input.now.getTime()}
    where exists (select 1 from articles where articles.id = ${input.articleId})
    on conflict (article_id) do update set attempted_at = excluded.attempted_at
    where page_contents.status = 'failed'
  `);
}
