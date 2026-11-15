import { decodeHTMLAttribute } from "entities";
import { parseAttributes, tokenizeHtml } from "../lib/html";
import { FetchFeedError, fetchFeed } from "./fetch-feed";
import { FetchImageError, fetchImage } from "./fetch-image";
import { toHttpUrl } from "./parse-feed";
import { MAX_IMAGE_URL_LENGTH } from "./thumbnail";

/*
 * フィードのアイコンを探す（docs/decisions/images.md の 8）。
 */

/** サイトのページのうち、<link> を探す範囲（<head> は先頭にある） */
const MAX_SCAN_LENGTH = 512 * 1024;
const MAX_TAG_LENGTH = 4096;
/** サイトのページの大きさの上限 */
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
/** 1 つの取得にかける時間の上限。取得のジョブのついでに探すので、短くする */
const TIMEOUT_MS = 5_000;
/** 確かめる候補の数の上限 */
const MAX_CANDIDATES = 5;

/**
 * アイコンの URL を探す。候補を順に実際に取得し、画像と確かめられた最初のものを返す。
 * どれも確かめられなければ null。
 *
 * 候補の順：
 * 1. フィード自身のアイコン
 * 2. サイトのページの <link rel="apple-touch-icon"> ／ <link rel="icon">
 * 3. サイトの /favicon.ico
 * 4. 今のアイコン（サイトのページが一時的に取れないだけで、アイコンを消さないように）
 */
export async function findFeedIcon(input: {
  fetch: typeof fetch;
  feedIconUrl: string | null;
  siteUrl: string | null;
  currentIconUrl: string | null;
}): Promise<string | null> {
  // 確かめた候補の数。同じ URL は 1 回だけ確かめる
  const tried = new Set<string>();
  const check = async (url: string | null): Promise<string | null> => {
    if (url === null || url.length > MAX_IMAGE_URL_LENGTH) return null;
    if (tried.has(url) || tried.size >= MAX_CANDIDATES) return null;
    tried.add(url);
    return (await isImage(url, input.fetch)) ? url : null;
  };

  // 先の候補が画像なら、後の候補のための取得（サイトのページなど）はしない
  const fromFeed = await check(input.feedIconUrl);
  if (fromFeed !== null) return fromFeed;

  if (input.siteUrl !== null) {
    for (const url of await findPageIcons(input.siteUrl, input.fetch)) {
      const fromPage = await check(url);
      if (fromPage !== null) return fromPage;
    }
    const favicon = await check(toHttpUrl("/favicon.ico", input.siteUrl));
    if (favicon !== null) return favicon;
  }
  // 今のアイコンは、数の上限にかかわらず確かめる（確かめずに消さない）
  const current = input.currentIconUrl;
  if (current !== null && !tried.has(current) && (await isImage(current, input.fetch))) {
    return current;
  }
  return null;
}

/** 実際に取得して、中継で通す形式の画像か（docs/decisions/images.md の 5）を確かめる */
async function isImage(url: string, fetcher: typeof fetch): Promise<boolean> {
  try {
    const image = await fetchImage(url, { fetch: fetcher, timeoutMs: TIMEOUT_MS });
    await image.body.cancel();
    return true;
  } catch (error) {
    if (error instanceof FetchImageError) return false;
    throw error;
  }
}

/** サイトのページを取得して、アイコンの候補を返す。取得できなければ空 */
async function findPageIcons(siteUrl: string, fetcher: typeof fetch): Promise<string[]> {
  try {
    const page = await fetchFeed(siteUrl, {
      fetch: fetcher,
      timeoutMs: TIMEOUT_MS,
      maxBytes: MAX_PAGE_BYTES,
    });
    return page.status === "ok" ? findIconLinks(page.body, page.url) : [];
  } catch (error) {
    if (error instanceof FetchFeedError) return [];
    throw error;
  }
}

/**
 * HTML から、アイコンを指す <link> を探す。apple-touch-icon（大きめの PNG が多い）を先に、
 * そのあとに icon を、書かれた順で返す。SVG と分かるもの（type か拡張子）は除く（中継で通さない）。
 *
 * コメントや script の中の <link> は読まない。外部から来る入力なので、長さに比例する時間で読む
 * トークナイザー（lib/html.ts）を使う
 */
export function findIconLinks(html: string, pageUrl: string): string[] {
  const links: { href: string | undefined; touch: boolean }[] = [];
  // 相対 URL の基準は、最初の <base href>。<link> より後に書かれていても文書全体に効く
  let base: string | null = null;

  for (const token of tokenizeHtml(html.slice(0, MAX_SCAN_LENGTH))) {
    if (token.type !== "tag" || token.closing) continue;
    if (token.name !== "link" && token.name !== "base") continue;
    if (token.attributes.length > MAX_TAG_LENGTH) continue;

    const attributes = parseAttributes(token.attributes);
    const value = (name: string) => {
      const raw = attributes.get(name);
      return raw === undefined ? undefined : decodeHTMLAttribute(raw);
    };

    if (token.name === "base") {
      if (base === null && attributes.has("href")) base = toHttpUrl(value("href"), pageUrl);
      continue;
    }

    const rel = value("rel")?.toLowerCase().split(/\s+/) ?? [];
    const touch = rel.includes("apple-touch-icon") || rel.includes("apple-touch-icon-precomposed");
    if (!touch && !rel.includes("icon")) continue;
    if (value("type")?.toLowerCase().includes("svg")) continue;
    links.push({ href: value("href"), touch });
  }

  const urls: string[] = [];
  for (const link of [...links.filter((l) => l.touch), ...links.filter((l) => !l.touch)]) {
    const url = toHttpUrl(link.href, base ?? pageUrl);
    if (url === null || urls.includes(url)) continue;
    if (new URL(url).pathname.toLowerCase().endsWith(".svg")) continue;
    urls.push(url);
  }
  return urls;
}
