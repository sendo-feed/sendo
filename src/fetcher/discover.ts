import { FetchFeedError, fetchFeed } from "./fetch-feed";
import { decodeEntities, ParseFeedError, parseFeed, toHttpUrl } from "./parse-feed";
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
  "application/json",
]);

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
 * 外部から来る入力なので、先頭から 1 回なめるだけで終わるようにする（正規表現で
 * タグ全体を探すと、閉じていないタグが大量にあるときに時間が二乗で増える）。
 */
export function findFeedLinks(html: string, baseUrl: string): FeedCandidate[] {
  const text = html.slice(0, MAX_SCAN_LENGTH);
  const candidates: FeedCandidate[] = [];
  const seen = new Set<string>();
  const open = /<link\b/gi;

  for (let match = open.exec(text); match !== null; match = open.exec(text)) {
    const end = text.indexOf(">", match.index);
    if (end === -1) break;
    open.lastIndex = end + 1;
    if (end - match.index > MAX_TAG_LENGTH) continue;

    const attributes = parseAttributes(text.slice(match.index + 5, end));
    const rel = attributes.get("rel")?.toLowerCase().split(/\s+/) ?? [];
    const type = attributes.get("type")?.toLowerCase().split(";")[0]?.trim() ?? "";
    if (!rel.includes("alternate") || !FEED_TYPES.has(type)) continue;

    const url = toHttpUrl(attributes.get("href"), baseUrl);
    if (url === null || seen.has(url)) continue;
    seen.add(url);
    candidates.push({ url, title: attributes.get("title")?.trim() || null });
  }
  return candidates;
}

/** タグの中の属性を読む。値の文字参照は戻す。同じ名前は最初のものを使う */
function parseAttributes(source: string): Map<string, string> {
  const attributes = new Map<string, string>();
  const pattern = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const [, name, double, single, bare] of source.matchAll(pattern)) {
    if (name === undefined) continue;
    const key = name.toLowerCase();
    if (!attributes.has(key)) attributes.set(key, decodeEntities(double ?? single ?? bare ?? ""));
  }
  return attributes;
}
