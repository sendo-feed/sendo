import { configureStorage } from "../db/storage";
import { htmlToText } from "../fetcher/parse-feed";
import type { Platform } from "../platform";

export const SEARCH_INDEX_BATCH_SIZE = 10;
const MAX_SEARCH_TEXT_LENGTH = 20_000;
const encoder = new TextEncoder();

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
    const content = [row.title, row.summary, htmlToText(body ?? undefined, MAX_SEARCH_TEXT_LENGTH)]
      .filter(Boolean)
      .join("\n");
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
