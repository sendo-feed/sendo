/**
 * 記事のページの本文（docs/decisions/content.md の 10〜18）。取り込んだときに抜く仕事（extract-page）が
 * 抜き、読者が開いたときにまだ抜いていなければ、そのリクエストの中で抜く。
 * サニタイズした本文は、DB の行に入れる（置き場には置かない）。結果は全員で共有する。
 *
 * 抜く処理は緩衝層（platform.pageContent。Rust）が持つ。
 *
 * ページを取りにいくときは、同じホストへは 1 本ずつにし（決定の 17）、robots.txt を守る（決定の 18）。
 * どちらの状態も、プロセスのメモリに持つ（Sendo は 1 つのプロセスで動く）。
 */
import { getArticlePageUrl } from "../db/articles";
import { MAX_CONTENT_BYTES } from "../db/content";
import {
  getPageContent,
  PAGE_CONTENT_RETRY_MS,
  recordExtractedPageContent,
  recordFailedPageContent,
} from "../db/page-contents";
import { enqueueArticleLanguages } from "../jobs/article-languages";
import { canStoreArticles } from "../jobs/storage";
import { enqueueDecideTranslations } from "../jobs/translations";
import { findImgurPosts, sanitizeHtml } from "../lib/sanitize-html";
import type { PageContentExtractor, Platform } from "../platform";
import { FetchPageError, fetchPage } from "./fetch-page";
import { type GatePriority, GateTicket, HostGate } from "./host-gate";
import { resolveImgurPosts } from "./imgur-posts";
import { createPageFetchBudget, type PageFetchBudget, resolvePageImages } from "./page-images";
import { htmlToText } from "./parse-feed";
import { RobotsCache } from "./robots";

/** 返す本文。html は保存したもの（サニタイズ済み）。返す前に、もう一度サニタイズする */
export type PageContentResult = { status: "ok"; html: string } | { status: "unavailable" };

type PageContentPlatform = Pick<
  Platform,
  "db" | "fetch" | "now" | "retentionConfig" | "jobs" | "translator"
>;

/**
 * 同じ記事を、同じプロセスで同時に抜かないようにする（抜く仕事と、開いたときの抜き取りが重なった
 * とき、取りにいくのを 1 回にする）。別のプロセスとの重なりは、DB に書く文の中で確かめる
 * （db/page-contents.ts）
 */
const inflight = new Map<string, { task: Promise<PageContentResult>; ticket: GateTicket }>();

/** 同じホストへの取得の間隔（決定の 17） */
export const SAME_HOST_INTERVAL_MS = 1000;

// サイト紹介やコメント欄の案内だけを抜いた結果を、本文として保存しないための下限。
// サニタイズ後の文字を数える。HTML の長さや、抜く処理が返す文字数は使わない。
const MIN_PAGE_TEXT_LENGTH = 100;

/** 同じホストへの取得を、1 本ずつにする（決定の 17） */
const hostGate = new HostGate({ intervalMs: SAME_HOST_INTERVAL_MS });

/** robots.txt の結果（決定の 18） */
const robots = new RobotsCache();

/**
 * 読者が開いたときに、記事のページの本文を返す。抜いてあれば行から、なければ取りにいって抜く。
 * 抜けなかった記事は、PAGE_CONTENT_RETRY_MS たつまで取りにいき直さない
 */
export async function loadPageContent(
  platform: PageContentPlatform,
  extractor: PageContentExtractor,
  articleId: string,
): Promise<PageContentResult> {
  const row = await getPageContent(platform.db, articleId);
  if (row?.status === "extracted" && row.html !== null) return { status: "ok", html: row.html };
  if (
    row?.status === "failed" &&
    platform.now().getTime() - row.attemptedAt.getTime() < PAGE_CONTENT_RETRY_MS
  ) {
    return { status: "unavailable" };
  }
  const article = await getArticlePageUrl(platform.db, articleId);
  if (!article?.url) return { status: "unavailable" };
  // 読者が待っているので、抜く仕事より前に並べる
  return extractOnce(platform, extractor, { id: articleId, url: article.url }, "interactive");
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
  const article = await getArticlePageUrl(platform.db, articleId);
  // 記事が消えた（片付けられた）か、URL がない
  if (!article?.url) return;
  await extractOnce(platform, extractor, { id: articleId, url: article.url }, "background");
}

/** 同じ記事を同時に抜かないようにして、抜いて記録する */
function extractOnce(
  platform: PageContentPlatform,
  extractor: PageContentExtractor,
  article: { id: string; url: string },
  priority: GatePriority,
): Promise<PageContentResult> {
  const running = inflight.get(article.id);
  if (running) {
    // 抜く仕事が順番を待っている記事を読者が開いたら、読者の位置へ並び直す（決定の 17）
    if (priority === "interactive") running.ticket.promote();
    return running.task;
  }
  const ticket = new GateTicket(priority);
  const task = extractAndRecord(platform, extractor, article, ticket).finally(() =>
    inflight.delete(article.id),
  );
  inflight.set(article.id, { task, ticket });
  return task;
}

async function extractAndRecord(
  platform: PageContentPlatform,
  extractor: PageContentExtractor,
  article: { id: string; url: string },
  ticket: GateTicket,
): Promise<PageContentResult> {
  if (!(await canStoreArticles(platform))) return { status: "unavailable" };
  const html = await extract(platform, extractor, article, ticket);
  if (html === null) {
    await recordFailedPageContent(platform.db, { articleId: article.id, now: platform.now() });
    // ページの判定を待たずに、訳すかどうかを決める（docs/decisions/jobs.md の 13）
    await enqueueDecideTranslations(platform, [article.id]);
    return { status: "unavailable" };
  }
  // 抜く仕事と開いたときの抜き取りが重なったら、先に書いたほうが残る。残ったほうを返す
  const stored = await recordExtractedPageContent(platform.db, {
    articleId: article.id,
    html,
    now: platform.now(),
  });
  if (stored === null) return { status: "unavailable" };
  // 抜いた本文の言語の判定を積む（docs/decisions/jobs.md の 13）。積めなければ定期実行が拾う
  await enqueueArticleLanguages(platform, [article.id]);
  return { status: "ok", html: stored };
}

/**
 * 記事のページを取りにいく。記事の URL のホストの順番を待ち、robots.txt の取得とリダイレクトを含めて、
 * そのホストへの取得を 1 本にする（決定の 17）。取りにいく URL ごとに robots.txt を確かめる（決定の 18）
 */
function politeFetchPage(
  platform: Pick<Platform, "fetch" | "now">,
  url: string,
  ticket: GateTicket,
): ReturnType<typeof fetchPage> {
  const fetchIt = () =>
    fetchPage(url, {
      fetch: platform.fetch,
      isAllowed: async (target) =>
        (await robots.denial(target, { fetch: platform.fetch, now: platform.now() })) ?? true,
    });
  // URL として読めなければ、順番を待たずに fetchPage に断らせる（blocked_url）
  const host = URL.canParse(url) ? new URL(url).hostname : null;
  return host === null ? fetchIt() : hostGate.run(host, ticket, fetchIt);
}

/** ページを取りにいって本文を抜き、サニタイズする。抜けなければ null（理由はログにだけ出す） */
async function extract(
  platform: Pick<Platform, "fetch" | "now">,
  extractor: PageContentExtractor,
  article: { id: string; url: string },
  ticket: GateTicket,
): Promise<string | null> {
  const detail = { articleId: article.id };
  let page: Awaited<ReturnType<typeof fetchPage>>;
  try {
    page = await politeFetchPage(platform, article.url, ticket);
  } catch (error) {
    if (error instanceof FetchPageError) {
      console.warn("could not fetch the article page", {
        ...detail,
        code: error.code,
        ...error.detail,
      });
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
  let html = sanitizeHtml(extracted.html, page.url);
  const text = htmlToText(html, Number.POSITIVE_INFINITY) ?? "";
  const textLength = [...text].length;
  if (textLength < MIN_PAGE_TEXT_LENGTH) {
    console.warn("the extracted content is too short after sanitizing", { ...detail, textLength });
    return null;
  }
  if (new TextEncoder().encode(html).length > MAX_CONTENT_BYTES) {
    console.warn("the extracted content is too large", detail);
    return null;
  }
  // 本文の外の取得（Imgur の投稿のページ、本文の画像）は、記事のページと同じ順番に並び、
  // robots.txt を守る（決定の 17、18、20、22）
  const isAllowed = (target: URL, fetcher: typeof fetch, signal: AbortSignal) =>
    robots.isAllowed(target, { fetch: fetcher, now: platform.now(), signal });
  const run = <T>(url: string, task: () => Promise<T>) => {
    if (!URL.canParse(url)) return task();
    return hostGate.run(new URL(url).hostname, ticket, task);
  };
  // 投稿のページを書いた Imgur の公式埋め込みは、投稿のページを調べて画像を足す（決定の 22）。
  // 見分ける手掛かりの class は抜いた HTML にしかないので、抜いた HTML をサニタイズし直して足す。
  // 上限は、拡大画像（20）と導入の画像（21）と分け合い、ここが先に使う
  let budget: PageFetchBudget | undefined;
  const posts = findImgurPosts(extracted.html, page.url);
  if (posts.length > 0) {
    budget = createPageFetchBudget(platform.fetch);
    const images = await resolveImgurPosts(posts, { budget, isAllowed, run });
    if (images.size > 0) {
      const withImages = sanitizeHtml(extracted.html, page.url, { imgurPostImages: images });
      if (new TextEncoder().encode(withImages).byteLength <= MAX_CONTENT_BYTES) html = withImages;
    }
  }
  if (extractor.images) {
    const original = html;
    html = await resolvePageImages(html, page.url, extractor.images, {
      fetch: platform.fetch,
      isAllowed,
      run,
      budget,
    });
    html = sanitizeHtml(html, page.url);
    if (new TextEncoder().encode(html).byteLength > MAX_CONTENT_BYTES) html = original;
  }
  return html;
}
