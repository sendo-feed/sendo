import { decodeHTML } from "entities";
import { type AnyFeed, parseFeed as parseAnyFeed } from "feedsmith";
import { stripTags } from "../lib/html";

export { stripTags };

/** 形式（RSS ／ Atom ／ RDF ／ JSON Feed）の違いをならした、フィードの中身 */
export type ParsedFeed = {
  title: string | null;
  siteUrl: string | null;
  items: ParsedItem[];
};

export type ParsedItem = {
  /** フィードが付けた記事の ID（RSS の guid、Atom の id など）。なければ null */
  id: string | null;
  /** http ／ https の URL だけ。それ以外（javascript: など）は null にする */
  url: string | null;
  /** タグを除いたプレーンテキスト */
  title: string | null;
  /** タグを除き、長さを切り詰めたプレーンテキスト */
  summary: string | null;
  author: string | null;
  publishedAt: Date | null;
};

export class ParseFeedError extends Error {
  override readonly name = "ParseFeedError";
}

/** 1 回の取得で取り込む記事の上限。巨大なフィードで処理が重くならないようにする */
export const MAX_ITEMS = 200;
export const MAX_SUMMARY_LENGTH = 500;
const MAX_TITLE_LENGTH = 500;

/**
 * フィードの本文を解析する。
 *
 * 記事の本文は外部から来る信頼できないデータなので、HTML のままは持たない。
 * タイトルと要約はタグを除いたプレーンテキストにし、URL は http ／ https だけを通す。
 * 本文の全文（HTML）は、サニタイズと合わせて Phase 2 の全文抽出で扱う。
 *
 * @param baseUrl 相対 URL を解決するときの基準（フィードを取得した URL）
 */
export function parseFeed(body: string, baseUrl: string): ParsedFeed {
  let parsed: AnyFeed;
  try {
    parsed = parseAnyFeed(body, { maxItems: MAX_ITEMS });
  } catch (error) {
    throw new ParseFeedError(error instanceof Error ? error.message : String(error));
  }

  const base = (url: string | undefined) => toHttpUrl(url, baseUrl);
  // 欄によって中身が HTML かプレーンテキストかが決まっている。HTML の欄だけタグを除く。
  // プレーンテキストの欄にタグの除去をかけると、「x < y」のような本文が壊れる
  const html = (value: string | undefined, max: number) => htmlToText(value, max);
  const plain = (value: string | undefined, max: number) => normalizeText(value, max);
  // Atom の text 要素は、type 属性で HTML かどうかが分かる
  const atomText = (value: { value?: string; type?: string } | undefined, max: number) =>
    value?.type === "html" || value?.type === "xhtml"
      ? html(value.value, max)
      : plain(value?.value, max);

  switch (parsed.format) {
    case "rss": {
      const { feed } = parsed;
      return {
        title: plain(feed.title, MAX_TITLE_LENGTH),
        siteUrl: base(feed.link),
        items: (feed.items ?? []).map((item) => ({
          id: nonEmpty(item.guid?.value),
          url: base(item.link),
          title: plain(item.title, MAX_TITLE_LENGTH),
          summary: html(item.description ?? item.content?.encoded, MAX_SUMMARY_LENGTH),
          author: plain(item.authors?.[0]?.name ?? item.dc?.creators?.[0], MAX_TITLE_LENGTH),
          publishedAt: toDate(item.pubDate ?? item.dc?.dates?.[0]),
        })),
      };
    }
    case "atom": {
      const { feed } = parsed;
      return {
        title: atomText(feed.title, MAX_TITLE_LENGTH),
        siteUrl: base(alternateLink(feed.links)),
        items: (feed.entries ?? []).map((entry) => ({
          id: nonEmpty(entry.id),
          url: base(alternateLink(entry.links)),
          title: atomText(entry.title, MAX_TITLE_LENGTH),
          summary: atomText(entry.summary ?? entry.content, MAX_SUMMARY_LENGTH),
          author: plain(entry.authors?.[0]?.name, MAX_TITLE_LENGTH),
          publishedAt: toDate(entry.published ?? entry.updated ?? entry.dc?.dates?.[0]),
        })),
      };
    }
    case "rdf": {
      const { feed } = parsed;
      return {
        title: plain(feed.title, MAX_TITLE_LENGTH),
        siteUrl: base(feed.link),
        items: (feed.items ?? []).map((item) => ({
          id: null,
          url: base(item.link),
          title: plain(item.title, MAX_TITLE_LENGTH),
          summary: html(item.description ?? item.content?.encoded, MAX_SUMMARY_LENGTH),
          author: plain(item.dc?.creators?.[0], MAX_TITLE_LENGTH),
          publishedAt: toDate(item.dc?.dates?.[0]),
        })),
      };
    }
    case "json": {
      const { feed } = parsed;
      return {
        title: plain(feed.title, MAX_TITLE_LENGTH),
        siteUrl: base(feed.home_page_url),
        items: (feed.items ?? []).map((item) => ({
          id: nonEmpty(item.id),
          url: base(item.url),
          title: plain(item.title, MAX_TITLE_LENGTH),
          // summary と content_text はプレーンテキスト、content_html だけが HTML
          summary:
            plain(item.summary ?? item.content_text, MAX_SUMMARY_LENGTH) ??
            html(item.content_html, MAX_SUMMARY_LENGTH),
          author: plain(item.authors?.[0]?.name, MAX_TITLE_LENGTH),
          publishedAt: toDate(item.date_published ?? item.date_modified),
        })),
      };
    }
  }
}

function alternateLink(
  links: ReadonlyArray<{ href?: string; rel?: string }> | undefined,
): string | undefined {
  return (links?.find((link) => (link.rel ?? "alternate") === "alternate") ?? links?.[0])?.href;
}

function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** http ／ https の絶対 URL にする。それ以外のスキームや壊れた URL は null */
export function toHttpUrl(value: string | undefined, baseUrl: string): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed, baseUrl);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * HTML をプレーンテキストにする。
 *
 * 結果は「表示する側でエスケープする文字列」として扱う。ここでタグを除くのは
 * 読みやすさと大きさのためで、安全のためのサニタイズではない。
 * 外部から来る入力なので、長さに比例する時間で読むトークナイザー（lib/html.ts）を使う。
 */
export function htmlToText(value: string | undefined, maxLength: number): string | null {
  if (value === undefined) return null;
  return normalizeText(decodeEntities(stripTags(value)), maxLength);
}

/**
 * HTML の文字参照（&amp;、&raquo;、&#12354; など）をもとに戻す。
 * HTML5 の文字参照をすべて扱う entities を使う（feedsmith も使っている）。
 */
export function decodeEntities(text: string): string {
  return decodeHTML(text);
}

/** プレーンテキストの空白をまとめ、長すぎれば切り詰める。中身には手を加えない */
export function normalizeText(value: string | undefined, maxLength: number): string | null {
  if (value === undefined) return null;
  const text = value.replace(/\s+/g, " ").trim();
  if (text === "") return null;
  const chars = [...text];
  return chars.length > maxLength ? `${chars.slice(0, maxLength - 1).join("")}…` : text;
}

function toDate(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
