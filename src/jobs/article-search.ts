import { configureStorage } from "../db/storage";
import { htmlToText } from "../fetcher/parse-feed";
import type { Platform } from "../platform";

export const SEARCH_INDEX_BATCH_SIZE = 10;
/** 本文のプレーンテキストを切る長さ（docs/decisions/article-search.md の 2） */
const MAX_SEARCH_TEXT_LENGTH = 20_000;
const encoder = new TextEncoder();

/**
 * 記事の文字。タイトル、要約、本文（プレーンテキストにした先頭 20,000 文字）を、空でないものだけ
 * 改行でつなぐ。検索の索引と、ベルの言葉の判定（docs/decisions/notifications.md の 8）で同じ切り方を使う
 */
export function articleText(article: {
  title: string | null;
  summary: string | null;
  bodyHtml: string | null;
}): string {
  return [
    article.title,
    article.summary,
    htmlToText(article.bodyHtml ?? undefined, MAX_SEARCH_TEXT_LENGTH),
  ]
    .filter(Boolean)
    .join("\n");
}

export async function indexArticleSearch(
  platform: Pick<Platform, "articleSearch" | "db" | "content" | "retentionConfig">,
): Promise<void> {
  const { articleSearch, db } = platform;
  await configureStorage(db, platform.retentionConfig.maxBytes);
  for (const row of await articleSearch.pending(SEARCH_INDEX_BATCH_SIZE)) {
    let body = row.pageHtml;
    if (body === null && row.contentKey !== null) {
      try {
        body = await platform.content.get(row.contentKey);
      } catch (error) {
        console.warn("could not read article search input", { articleId: row.articleId, error });
      }
      if (body === null) {
        await articleSearch.retry(row);
        continue;
      }
    }
    const content = articleText({ title: row.title, summary: row.summary, bodyHtml: body });
    // 文字列と trigram 索引、行の大きさの見積もり。
    const bytes = 512 + encoder.encode(content).length * 8;
    if (
      !(await articleSearch.store({
        articleId: row.articleId,
        revision: row.revision,
        content,
        bytes,
      }))
    ) {
      await articleSearch.retry(row);
    }
  }
}
