import { type AnyFeed, parseFeed as parseAnyFeed } from "feedsmith";

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
  const text = (value: string | undefined, max: number) => toPlainText(value, max);

  switch (parsed.format) {
    case "rss": {
      const { feed } = parsed;
      return {
        title: text(feed.title, MAX_TITLE_LENGTH),
        siteUrl: base(feed.link),
        items: (feed.items ?? []).map((item) => ({
          id: nonEmpty(item.guid?.value),
          url: base(item.link),
          title: text(item.title, MAX_TITLE_LENGTH),
          summary: text(item.description ?? item.content?.encoded, MAX_SUMMARY_LENGTH),
          author: text(item.authors?.[0]?.name ?? item.dc?.creators?.[0], MAX_TITLE_LENGTH),
          publishedAt: toDate(item.pubDate ?? item.dc?.dates?.[0]),
        })),
      };
    }
    case "atom": {
      const { feed } = parsed;
      return {
        title: text(feed.title?.value, MAX_TITLE_LENGTH),
        siteUrl: base(alternateLink(feed.links)),
        items: (feed.entries ?? []).map((entry) => ({
          id: nonEmpty(entry.id),
          url: base(alternateLink(entry.links)),
          title: text(entry.title?.value, MAX_TITLE_LENGTH),
          summary: text(entry.summary?.value ?? entry.content?.value, MAX_SUMMARY_LENGTH),
          author: text(entry.authors?.[0]?.name, MAX_TITLE_LENGTH),
          publishedAt: toDate(entry.published ?? entry.updated ?? entry.dc?.dates?.[0]),
        })),
      };
    }
    case "rdf": {
      const { feed } = parsed;
      return {
        title: text(feed.title, MAX_TITLE_LENGTH),
        siteUrl: base(feed.link),
        items: (feed.items ?? []).map((item) => ({
          id: null,
          url: base(item.link),
          title: text(item.title, MAX_TITLE_LENGTH),
          summary: text(item.description ?? item.content?.encoded, MAX_SUMMARY_LENGTH),
          author: text(item.dc?.creators?.[0], MAX_TITLE_LENGTH),
          publishedAt: toDate(item.dc?.dates?.[0]),
        })),
      };
    }
    case "json": {
      const { feed } = parsed;
      return {
        title: text(feed.title, MAX_TITLE_LENGTH),
        siteUrl: base(feed.home_page_url),
        items: (feed.items ?? []).map((item) => ({
          id: nonEmpty(item.id),
          url: base(item.url),
          title: text(item.title, MAX_TITLE_LENGTH),
          summary: text(item.summary ?? item.content_text ?? item.content_html, MAX_SUMMARY_LENGTH),
          author: text(item.authors?.[0]?.name, MAX_TITLE_LENGTH),
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

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/**
 * HTML をプレーンテキストにする。
 *
 * 結果は「表示する側でエスケープする文字列」として扱う。ここでタグを除くのは
 * 読みやすさと大きさのためで、安全のためのサニタイズではない。
 */
export function toPlainText(value: string | undefined, maxLength: number): string | null {
  if (value === undefined) return null;
  const text = value
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code: string) => {
      if (code.startsWith("#")) {
        const point =
          code[1] === "x" || code[1] === "X"
            ? Number.parseInt(code.slice(2), 16)
            : Number.parseInt(code.slice(1), 10);
        return Number.isInteger(point) && point > 0 && point <= 0x10ffff
          ? String.fromCodePoint(point)
          : entity;
      }
      return NAMED_ENTITIES[code.toLowerCase()] ?? entity;
    })
    .replace(/\s+/g, " ")
    .trim();
  if (text === "") return null;
  return [...text].length > maxLength ? `${[...text].slice(0, maxLength - 1).join("")}…` : text;
}

function toDate(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
