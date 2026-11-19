import { decodeHTMLAttribute } from "entities";
import { parseAttributes, tokenizeHtml } from "../lib/html";
import {
  type FetchedFeedPage,
  FetchFeedError,
  type FetchFeedOptions,
  fetchFeed,
} from "./fetch-feed";
import { ParseFeedError, parseFeed, toHttpUrl } from "./parse-feed";
import { toFetchableUrl, UrlNotAllowedError } from "./url-guard";

/** HTML の中で見つけたフィードの候補 */
export type FeedCandidate = { url: string; title: string | null };

/** フィードとして読める URL と、そのフィードのタイトル */
export type DiscoveredFeed = { url: string; title: string | null };

export type FeedRelocationCandidate = DiscoveredFeed & { siteUrl: string | null };

export class DiscoverError extends Error {
  override readonly name = "DiscoverError";
  constructor(
    readonly code: "fetch_failed" | "feed_not_found",
    message: string,
  ) {
    super(message);
  }
}

/** フィードを指す <link> の type */
const FEED_TYPES = new Set([
  "application/rss+xml",
  "application/atom+xml",
  "application/rdf+xml",
  "application/feed+json",
]);
// application/json は入れない。WordPress などは、REST API を指す <link rel="alternate"
// type="application/json"> をどのページにも置くので、フィードでない候補が混ざる

/** HTML のうち、<link> を探す範囲。<link> はふつう <head> にあるので、先頭だけで足りる */
export const MAX_FEED_LINK_PAGE_BYTES = 512 * 1024;
/** 1 つのタグとして読む長さの上限 */
const MAX_TAG_LENGTH = 4096;
/** 候補を確かめる数の上限。外部への取得の回数を抑える */
const MAX_TRIES = 3;
const RELOCATION_TIMEOUT_MS = 5_000;
const MAX_RELOCATION_URL_LENGTH = 2048;

/**
 * URL がフィードならそのまま、Web ページなら <link rel="alternate"> からフィードを見つける。
 *
 * 見つけた候補は実際に取得して、フィードとして読めるかを確かめる（最初に読めたものを返す）。
 */
export async function discoverFeed(
  url: URL,
  options: { fetch: typeof fetch },
): Promise<DiscoveredFeed> {
  const page = await fetchOrFail(url.href, options);
  try {
    return { url: url.href, title: parseFeed(page.body, page.url).title };
  } catch (error) {
    if (!(error instanceof ParseFeedError)) throw error;
  }

  const found = await firstReadableFeedLink(page, options);
  if (found) return { url: found.url, title: found.title };
  throw new DiscoverError("feed_not_found", "no feed found at this URL");
}

/** 失敗した URL のページに残っているリンクから、読める移転先候補を 1 件探す */
export function findFeedRelocation(
  page: FetchedFeedPage,
  originalUrl: string,
  fetch: typeof globalThis.fetch,
): Promise<FeedRelocationCandidate | null> {
  return firstReadableFeedLink(page, {
    fetch,
    relocation: {
      excludedUrls: new Set([originalUrl, page.url]),
      deadline: performance.now() + RELOCATION_TIMEOUT_MS,
    },
  });
}

async function firstReadableFeedLink(
  page: FetchedFeedPage,
  options: {
    fetch: typeof globalThis.fetch;
    relocation?: { excludedUrls: ReadonlySet<string>; deadline: number };
  },
): Promise<FeedRelocationCandidate | null> {
  const { fetch, relocation } = options;
  const candidates = findFeedLinks(page.body, page.url);
  for (const candidate of candidates.slice(0, MAX_TRIES)) {
    try {
      const candidateUrl = toFetchableUrl(candidate.url).href;
      if (relocation?.excludedUrls.has(candidateUrl)) continue;
      if (relocation && candidateUrl.length > MAX_RELOCATION_URL_LENGTH) continue;

      const fetchOptions: Pick<FetchFeedOptions, "fetch" | "timeoutMs" | "maxBytes"> = { fetch };
      if (relocation) {
        const remaining = Math.ceil(relocation.deadline - performance.now());
        if (remaining <= 0) break;
        fetchOptions.timeoutMs = remaining;
        fetchOptions.maxBytes = MAX_FEED_LINK_PAGE_BYTES;
      }
      const feed = await fetchOrFail(candidateUrl, fetchOptions);
      if (relocation?.excludedUrls.has(feed.url)) continue;
      const parsed = parseFeed(feed.body, feed.url);
      const title = parsed.title ?? candidate.title;
      return {
        url: candidateUrl,
        title: relocation ? (title?.slice(0, 500) ?? null) : title,
        siteUrl: relocation ? relocationSiteUrl(parsed.siteUrl) : parsed.siteUrl,
      };
    } catch (error) {
      if (
        error instanceof UrlNotAllowedError ||
        error instanceof DiscoverError ||
        error instanceof ParseFeedError
      ) {
        continue;
      }
      throw error;
    }
  }
  return null;
}

function relocationSiteUrl(url: string | null): string | null {
  if (url === null || url.length > MAX_RELOCATION_URL_LENGTH) return null;
  try {
    return toFetchableUrl(url).href;
  } catch (error) {
    if (error instanceof UrlNotAllowedError) return null;
    throw error;
  }
}

async function fetchOrFail(
  url: string,
  options: Pick<FetchFeedOptions, "fetch" | "timeoutMs" | "maxBytes">,
) {
  try {
    const result = await fetchFeed(url, options);
    if (result.status !== "ok") throw new DiscoverError("fetch_failed", "unexpected 304");
    return result;
  } catch (error) {
    if (error instanceof FetchFeedError) throw new DiscoverError("fetch_failed", error.message);
    throw error;
  }
}

/**
 * HTML から、フィードを指す <link rel="alternate" type="..." href="..."> を探す。
 *
 * コメントや script の中の <link> は読まない。外部から来る入力なので、長さに比例する
 * 時間で読むトークナイザー（lib/html.ts）を使う。
 */
export function findFeedLinks(html: string, pageUrl: string): FeedCandidate[] {
  const links: { href: string | undefined; title: string | null }[] = [];
  // 相対 URL の基準は、最初の <base href>（ページの URL に対して解決したもの）。
  // HTML の決まりでは、<link> より後に書かれていても文書全体に効くので、最後まで読んでから解決する
  let base: string | null = null;

  for (const token of tokenizeHtml(html.slice(0, MAX_FEED_LINK_PAGE_BYTES))) {
    if (token.type !== "tag" || token.closing) continue;
    if (token.name !== "link" && token.name !== "base") continue;
    if (token.attributes.length > MAX_TAG_LENGTH) continue;

    const attributes = parseAttributes(token.attributes);
    const value = (name: string) => {
      const raw = attributes.get(name);
      // 属性の値は、本文と文字参照の規則が違う（「&not=2」の &not は戻さない）
      return raw === undefined ? undefined : decodeHTMLAttribute(raw);
    };

    if (token.name === "base") {
      if (base === null && attributes.has("href")) base = toHttpUrl(value("href"), pageUrl);
      continue;
    }

    const rel = value("rel")?.toLowerCase().split(/\s+/) ?? [];
    const type = value("type")?.toLowerCase().split(";")[0]?.trim() ?? "";
    if (!rel.includes("alternate") || !FEED_TYPES.has(type)) continue;
    links.push({ href: value("href"), title: value("title")?.trim() || null });
  }

  const candidates: FeedCandidate[] = [];
  const seen = new Set<string>();
  for (const link of links) {
    const url = toHttpUrl(link.href, base ?? pageUrl);
    if (url === null || seen.has(url)) continue;
    seen.add(url);
    candidates.push({ url, title: link.title });
  }
  return candidates;
}
