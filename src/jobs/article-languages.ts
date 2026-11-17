import { eq } from "drizzle-orm";
import {
  ARTICLE_LANGUAGE_BYTES,
  findPendingArticleLanguages,
  getArticleLanguage,
  type LanguageCursor,
  recordArticleLanguage,
} from "../db/article-languages";
import { getPageContent } from "../db/page-contents";
import { articles } from "../db/schema";
import { configureStorage, readStorageUsage } from "../db/storage";
import { escapeHtml } from "../lib/html";
import type { Platform } from "../platform";

/** 本文を読む・判定済みを確かめる・保存する、各 1 クエリでも上限内に収まる */
export const LANGUAGE_BATCH_SIZE = 10;

export async function detectArticleLanguages(
  platform: Pick<Platform, "db" | "content" | "jobs" | "languageDetection" | "retentionConfig">,
  after?: LanguageCursor,
): Promise<void> {
  const detector = platform.languageDetection;
  if (!detector) return;
  await configureStorage(platform.db, platform.retentionConfig.maxBytes);
  const pending = await findPendingArticleLanguages(
    platform.db,
    detector.pipelineRevision,
    LANGUAGE_BATCH_SIZE + 1,
    after,
  );
  let capacityBlocked = false;
  for (const { articleId, source } of pending.slice(0, LANGUAGE_BATCH_SIZE)) {
    const current = await getArticleLanguage(platform.db, articleId, source);
    if (current && current.pipelineRevision >= detector.pipelineRevision) continue;
    let html: string | null;
    if (source === "page") {
      const page = await getPageContent(platform.db, articleId);
      html = page?.status === "extracted" ? page.html : null;
    } else {
      const article = await platform.db
        .select({
          title: articles.title,
          summary: articles.summary,
          contentKey: articles.contentKey,
        })
        .from(articles)
        .where(eq(articles.id, articleId))
        .get();
      if (!article) continue;
      if (source === "feed") {
        try {
          html =
            article.contentKey === null ? null : await platform.content.get(article.contentKey);
        } catch (error) {
          console.warn("could not read article language input", { articleId, source, error });
          continue;
        }
      } else {
        html = `<p>${escapeHtml(article.title ?? "")} ${escapeHtml(article.summary ?? "")}</p>`;
      }
    }
    // 本文の置き場が一時的に読めない場合、空の入力として判定済みにしない。
    if (html === null) continue;
    let result: Awaited<ReturnType<typeof detector.detect>>;
    try {
      result = await detector.detect(html);
    } catch (error) {
      console.warn("could not detect article language", { articleId, source, error });
      continue;
    }
    const stored = await recordArticleLanguage(platform.db, {
      ...result,
      articleId,
      source,
      detector: detector.detector,
      pipelineRevision: detector.pipelineRevision,
      status: source === "metadata" && result.status === "detected" ? "provisional" : result.status,
    });
    if (!stored) {
      const usage = await readStorageUsage(platform.db);
      if (usage.bytes + ARTICLE_LANGUAGE_BYTES > usage.limitBytes) {
        capacityBlocked = true;
        break;
      }
    }
  }
  // 読めない本文が先頭にたまっても、カーソルを進めてほかの記事を処理する。
  // 容量不足では連続投入せず、定期実行で先頭から拾い直す。
  const last = pending[LANGUAGE_BATCH_SIZE - 1];
  if (!capacityBlocked && last && pending.length > LANGUAGE_BATCH_SIZE) {
    await platform.jobs.enqueue([{ type: "detect-article-languages", after: last }]);
  }
}
