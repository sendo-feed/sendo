/**
 * 記事のページの本文（docs/decisions/content.md の 10〜14）。コンテナ版では、取り込んだときに抜く仕事
 * （extract-page）が抜き、読者が開いたときにまだ抜いていなければ、そのリクエストの中で抜く。
 * サニタイズした本文は、DB の行に入れる（置き場には置かない）。結果は全員で共有する。
 *
 * 抜く処理は緩衝層（platform.pageContent）が持つ。持っていない版（Cloudflare 版）では呼ばない。
 */
import { getArticleUrl } from "../db/articles";
import { MAX_CONTENT_BYTES } from "../db/content";
import {
  getPageContent,
  PAGE_CONTENT_RETRY_MS,
  recordExtractedPageContent,
  recordFailedPageContent,
} from "../db/page-contents";
import { sanitizeHtml } from "../lib/sanitize-html";
import type { PageContentExtractor, Platform } from "../platform";
import { FetchPageError, fetchPage } from "./fetch-page";
import { htmlToText } from "./parse-feed";

/** 返す本文。html は保存したもの（サニタイズ済み）。返す前に、もう一度サニタイズする */
export type PageContentResult = { status: "ok"; html: string } | { status: "unavailable" };

type PageContentPlatform = Pick<Platform, "db" | "fetch" | "now">;

/**
 * 同じ記事を、同じプロセスで同時に抜かないようにする（抜く仕事と、開いたときの抜き取りが重なった
 * とき、取りにいくのを 1 回にする）。別のプロセスとの重なりは、DB に書く文の中で確かめる
 * （db/page-contents.ts）
 */
const inflight = new Map<string, Promise<PageContentResult>>();

/**
 * 読者が開いたときに、記事のページの本文を返す。抜いてあれば行から、なければ取りにいって抜く。
 * 抜けなかった記事は、PAGE_CONTENT_RETRY_MS たつまで取りにいき直さない
 */
export async function loadPageContent(
  platform: PageContentPlatform,
  extractor: PageContentExtractor,
  article: { id: string; url: string | null },
): Promise<PageContentResult> {
  const row = await getPageContent(platform.db, article.id);
  if (row?.status === "extracted" && row.html !== null) return { status: "ok", html: row.html };
  if (
    row?.status === "failed" &&
    platform.now().getTime() - row.attemptedAt.getTime() < PAGE_CONTENT_RETRY_MS
  ) {
    return { status: "unavailable" };
  }
  if (article.url === null) return { status: "unavailable" };
  return extractOnce(platform, extractor, { id: article.id, url: article.url });
}

/**
 * 取り込んだあとの、抜く仕事（extract-page）。まだ結果の行がなければ抜く。抜けなかった記録があれば、
 * 仕事ではやり直さない（決定の 14。開いたときに、1 日たってから取りにいき直す）
 */
export async function extractPageContentOnce(
  platform: PageContentPlatform,
  extractor: PageContentExtractor,
  articleId: string,
): Promise<void> {
  if (await getPageContent(platform.db, articleId)) return;
  const article = await getArticleUrl(platform.db, articleId);
  // 記事が消えた（片付けられた）か、URL がない
  if (!article?.url) return;
  await extractOnce(platform, extractor, { id: articleId, url: article.url });
}

/** 同じ記事を同時に抜かないようにして、抜いて記録する */
function extractOnce(
  platform: PageContentPlatform,
  extractor: PageContentExtractor,
  article: { id: string; url: string },
): Promise<PageContentResult> {
  const running = inflight.get(article.id);
  if (running) return running;
  const task = extractAndRecord(platform, extractor, article).finally(() =>
    inflight.delete(article.id),
  );
  inflight.set(article.id, task);
  return task;
}

async function extractAndRecord(
  platform: PageContentPlatform,
  extractor: PageContentExtractor,
  article: { id: string; url: string },
): Promise<PageContentResult> {
  const html = await extract(platform, extractor, article);
  if (html === null) {
    await recordFailedPageContent(platform.db, { articleId: article.id, now: platform.now() });
    return { status: "unavailable" };
  }
  // 抜く仕事と開いたときの抜き取りが重なったら、先に書いたほうが残る。残ったほうを返す
  const stored = await recordExtractedPageContent(platform.db, {
    articleId: article.id,
    html,
    now: platform.now(),
  });
  return stored === null ? { status: "unavailable" } : { status: "ok", html: stored };
}

/** ページを取りにいって本文を抜き、サニタイズする。抜けなければ null（理由はログにだけ出す） */
async function extract(
  platform: Pick<Platform, "fetch">,
  extractor: PageContentExtractor,
  article: { id: string; url: string },
): Promise<string | null> {
  const detail = { articleId: article.id };
  let page: Awaited<ReturnType<typeof fetchPage>>;
  try {
    page = await fetchPage(article.url, { fetch: platform.fetch });
  } catch (error) {
    if (error instanceof FetchPageError) {
      console.warn("could not fetch the article page", { ...detail, code: error.code });
      return null;
    }
    throw error;
  }

  let extracted: Awaited<ReturnType<PageContentExtractor["extract"]>>;
  try {
    extracted = await extractor.extract({
      bytes: page.bytes,
      contentType: page.contentType,
      url: page.url,
    });
  } catch (error) {
    console.error("could not extract the article page", { ...detail, error });
    return null;
  }
  if (extracted === null) {
    console.warn("no readable content in the article page", detail);
    return null;
  }

  // 抜いた HTML は、外から来たもの。保存する前にサニタイズする（決定の 2）
  const html = sanitizeHtml(extracted.html, page.url);
  if ((htmlToText(html, Number.POSITIVE_INFINITY) ?? "").trim() === "") {
    console.warn("the extracted content is empty after sanitizing", detail);
    return null;
  }
  if (new TextEncoder().encode(html).length > MAX_CONTENT_BYTES) {
    console.warn("the extracted content is too large", detail);
    return null;
  }
  return html;
}
