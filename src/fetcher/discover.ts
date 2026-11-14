import { decodeHTMLAttribute } from "entities";
import { parseAttributes, tokenizeHtml } from "../lib/html";
import { FetchFeedError, fetchFeed } from "./fetch-feed";
import { ParseFeedError, parseFeed, toHttpUrl } from "./parse-feed";
import { toFetchableUrl, UrlNotAllowedError } from "./url-guard";

/** HTML の中で見つけたフィードの候補 */
export type FeedCandidate = { url: string; title: string | null };

/** フィードとして読める URL と、そのフィードのタイトル */
export type DiscoveredFeed = { url: string; title: string | null };

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
const MAX_SCAN_LENGTH = 512 * 1024;
/** 1 つのタグとして読む長さの上限 */
const MAX_TAG_LENGTH = 4096;
/** 候補を確かめる数の上限。外部への取得の回数を抑える */
const MAX_TRIES = 3;

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

  const candidates = findFeedLinks(page.body, page.url);
  for (const candidate of candidates.slice(0, MAX_TRIES)) {
    let candidateUrl: string;
    try {
      candidateUrl = toFetchableUrl(candidate.url).href;
    } catch (error) {
      if (error instanceof UrlNotAllowedError) continue;
      throw error;
    }
    try {
      const feed = await fetchOrFail(candidateUrl, options);
      return { url: candidateUrl, title: parseFeed(feed.body, feed.url).title ?? candidate.title };
    } catch (error) {
      if (error instanceof DiscoverError || error instanceof ParseFeedError) continue;
      throw error;
    }
  }
  throw new DiscoverError("feed_not_found", "no feed found at this URL");
}

async function fetchOrFail(url: string, options: { fetch: typeof fetch }) {
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

  for (const token of tokenizeHtml(html.slice(0, MAX_SCAN_LENGTH))) {
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
