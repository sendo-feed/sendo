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
import { LANGUAGE_ARTICLES_PER_JOB } from "./job";
import { enqueueDecideTranslations } from "./translations";

/** 1 つの仕事で判定する件数（docs/decisions/jobs.md の 4）。残りは次の仕事に引き継ぐ */
export const LANGUAGE_BATCH_SIZE = 10;

/**
 * 記事の言語を判定して保存する（docs/decisions/article-language.md の 5）。articleIds を渡したら、
 * その記事の未処理の入力元だけ。残りは同じ記事の続きの仕事に引き継ぐ。容量が足りなければ続けない
 */
export async function detectArticleLanguages(
  platform: Pick<
    Platform,
    "db" | "content" | "jobs" | "languageDetection" | "retentionConfig" | "translator"
  >,
  after?: LanguageCursor,
  articleIds?: readonly string[],
): Promise<void> {
  const detector = platform.languageDetection;
  await configureStorage(platform.db, platform.retentionConfig.maxBytes);
  const pending = await findPendingArticleLanguages(
    platform.db,
    detector.pipelineRevision,
    LANGUAGE_BATCH_SIZE + 1,
    after,
    articleIds,
  );
  let capacityBlocked = false;
  /** 判定を保存した記事（訳すかどうかを決める仕事を積む） */
  const stored: string[] = [];
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
    const saved = await recordArticleLanguage(platform.db, {
      ...result,
      articleId,
      source,
      detector: detector.detector,
      pipelineRevision: detector.pipelineRevision,
      status: source === "metadata" && result.status === "detected" ? "provisional" : result.status,
    });
    if (saved) {
      stored.push(articleId);
    } else {
      const usage = await readStorageUsage(platform.db);
      if (usage.bytes + ARTICLE_LANGUAGE_BYTES > usage.limitBytes) {
        capacityBlocked = true;
        break;
      }
    }
  }
  // 保存した記事について、訳すかどうかを決める仕事を積む（docs/decisions/jobs.md の 13）
  await enqueueDecideTranslations(platform, stored);
  // 読めない本文が先頭にたまっても、カーソルを進めてほかの記事を処理する。
  // 容量不足では連続投入せず、定期実行で先頭から拾い直す。
  const last = pending[LANGUAGE_BATCH_SIZE - 1];
  if (!capacityBlocked && last && pending.length > LANGUAGE_BATCH_SIZE) {
    await platform.jobs.enqueue([
      {
        type: "detect-article-languages",
        after: last,
        ...(articleIds !== undefined && { articleIds: [...articleIds] }),
      },
    ]);
  }
}

/**
 * 記事の言語の判定を、その記事について積む（取り込んだとき、ページを抜き終えたとき。
 * docs/decisions/jobs.md の 13）。LANGUAGE_ARTICLES_PER_JOB 件ずつの仕事に分ける。積めなくても
 * 呼んだ側の処理は失敗にしない（10 分ごとの定期実行が拾う）
 */
export async function enqueueArticleLanguages(
  platform: Pick<Platform, "jobs">,
  articleIds: readonly string[],
): Promise<void> {
  const jobs = [];
  for (let i = 0; i < articleIds.length; i += LANGUAGE_ARTICLES_PER_JOB) {
    jobs.push({
      type: "detect-article-languages" as const,
      articleIds: articleIds.slice(i, i + LANGUAGE_ARTICLES_PER_JOB),
    });
  }
  if (jobs.length === 0) return;
  try {
    await platform.jobs.enqueue(jobs);
  } catch (error) {
    console.warn("could not enqueue article language detection; retrying at the next schedule", {
      error,
    });
  }
}
