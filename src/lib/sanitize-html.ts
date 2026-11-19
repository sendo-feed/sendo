import { decodeHTML } from "entities";
import { toFetchableUrl } from "../fetcher/url-guard";
import { escapeHtml, parseAttributes, tokenizeHtml } from "./html";
import { isTrackingImage } from "./tracking-image";

/*
 * 記事の本文（外部から来る HTML）のサニタイズ（docs/decisions/content.md の 2）。
 *
 * 決めたタグと属性だけを通し、ほかは落とす。計測用の画像（lib/tracking-image.ts）も落とす。
 * 出力は、ここで組み立て直した HTML だけにする（入力のタグの文字列を、そのまま写さない）。
 * 開いたタグは必ず閉じ、文字と属性の値はエスケープし直す。同じ入力をもう一度通しても、
 * 結果は変わらない。
 */

/** 中身を持たない要素 */
const VOID_ELEMENTS = new Set(["br", "hr", "img"]);

/** 通す要素（属性は ALLOWED_ATTRIBUTES のものだけ） */
const ALLOWED_ELEMENTS = new Set([
  ...["p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6"],
  ...["ul", "ol", "li", "dl", "dt", "dd", "blockquote", "pre", "code", "figure", "figcaption"],
  ...["table", "caption", "thead", "tbody", "tfoot", "tr", "th", "td"],
  ...["strong", "b", "em", "i", "u", "s", "del", "ins", "sub", "sup", "small", "mark"],
  ...["kbd", "abbr", "cite", "q", "a", "img", "div"],
]);

/**
 * 区切りの役目だけを残す要素。属性のない div にする（落とすと、前後の段落がつながってしまう）。
 * span などの、行の中の知らない要素は、タグを落として中身だけ残す
 */
const BLOCK_ALIASES = new Set([
  ...["section", "article", "main", "header", "footer", "aside", "nav", "address", "center"],
]);

/** 中身ごと落とす要素（script ／ style などは、トークナイザーが中身を読まずに飛ばす） */
const DROPPED_WITH_CONTENT = new Set([
  ...["iframe", "object", "embed", "video", "audio", "canvas", "svg", "math"],
  ...["head", "title", "select", "button", "template", "script", "style", "noscript", "textarea"],
]);

/** 落とすときに、その URL へのリンクに替える要素（埋め込みと動画・音声） */
const REPLACED_WITH_LINK = new Set(["iframe", "embed", "video", "audio"]);

/** 入れ子の深さの上限。これより深く開くタグは落とす（中身は残る） */
const MAX_DEPTH = 100;

const DIGITS = /^\d{1,5}$/;

type ImgurQuote = { hasImage: boolean };

/** サニタイズした HTML の部品。画像は、URL をあとで差し替えられるように分けて持つ */
type Part = string | { image: string; rest: string; imgurFallback?: ImgurQuote };

function toUrl(value: string | undefined, baseUrl: string, protocols: readonly string[]) {
  const trimmed = value === undefined ? "" : decodeHTML(value).trim();
  if (trimmed === "") return null;
  try {
    const url = new URL(trimmed, baseUrl);
    return protocols.includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

const HTTP = ["http:", "https:"] as const;

function isImgurImage(href: string): boolean {
  const url = new URL(href);
  return (
    url.protocol === "https:" &&
    url.hostname === "i.imgur.com" &&
    /\.(?:jpe?g|png|gif|webp|avif)$/i.test(url.pathname)
  );
}

function canRelayImage(src: string): boolean {
  try {
    toFetchableUrl(src);
    return true;
  } catch {
    return false;
  }
}

function sanitizeToParts(html: string, baseUrl: string, expandImgurEmbeds = false): Part[] {
  const parts: Part[] = [];
  /** 開いている（閉じタグを出していない）要素 */
  const open: string[] = [];
  const imgurQuotes = new Map<number, ImgurQuote>();
  // URL の断片は画像の取得先を変えない。リンクの前後で除外した画像も差し替えに使わない。
  const removedImgurImages = new Set<string>();
  const recordRemovedImage = (src: string | null) => {
    if (expandImgurEmbeds && src !== null && isImgurImage(src)) {
      removedImgurImages.add(src.split("#", 1)[0] ?? src);
    }
  };
  let imgurLink: { index: number; href: string; quote: ImgurQuote; alt?: string } | undefined;
  /** 中身ごと落としている要素と、その入れ子の数 */
  let dropping: { name: string; depth: number; wantsLink: boolean } | null = null;

  const closeLast = () => {
    imgurQuotes.delete(open.length);
    const name = open.pop();
    if (name === "a" && imgurLink !== undefined) {
      if (!imgurLink.quote.hasImage) {
        const alt = escapeHtml(imgurLink.alt ?? "Imgur");
        parts.splice(imgurLink.index, 0, {
          image: imgurLink.href,
          rest: ` alt="${alt}"`,
          imgurFallback: imgurLink.quote,
        });
      }
      imgurLink = undefined;
    }
    parts.push(`</${name}>`);
  };

  const closeUntil = (name: string) => {
    const index = open.lastIndexOf(name);
    if (index === -1) return;
    while (open.length > index) closeLast();
  };

  for (const token of tokenizeHtml(html)) {
    if (token.type === "comment") continue;

    if (dropping) {
      if (token.type !== "tag") continue;
      if (token.name === dropping.name) {
        dropping.depth += token.closing ? -1 : 1;
        if (dropping.depth === 0) dropping = null;
      } else if (dropping.wantsLink && token.name === "source") {
        // 動画・音声の行き先が、子の <source> に書いてある場合。最初に見つかった 1 つをリンクにする
        const src = toUrl(parseAttributes(token.attributes).get("src"), baseUrl, HTTP);
        if (src) {
          parts.push(link(src), escapeHtml(src), "</a>");
          dropping.wantsLink = false;
        }
      } else if (expandImgurEmbeds && !token.closing && token.name === "img") {
        recordRemovedImage(toUrl(parseAttributes(token.attributes).get("src"), baseUrl, HTTP));
      }
      continue;
    }

    if (token.type === "text") {
      // 文字参照を戻してから、エスケープし直す（「&lt;script&gt;」は文字のまま残る）
      parts.push(escapeHtml(decodeHTML(token.text)));
      continue;
    }

    const name = BLOCK_ALIASES.has(token.name) ? "div" : token.name;
    if (token.closing) {
      if (ALLOWED_ELEMENTS.has(name) && !VOID_ELEMENTS.has(name)) closeUntil(name);
      continue;
    }

    if (DROPPED_WITH_CONTENT.has(name)) {
      let linked = false;
      if (REPLACED_WITH_LINK.has(name)) {
        const src = toUrl(parseAttributes(token.attributes).get("src"), baseUrl, HTTP);
        if (src) parts.push(link(src), escapeHtml(src), "</a>");
        linked = src !== null;
      }
      // 自分で閉じる書き方（<embed ... />）や、閉じタグのない要素でも、あとの中身を巻き込まない
      // ように、中身を持たない要素は落とすだけにする
      if (name !== "embed" && !token.attributes.trimEnd().endsWith("/")) {
        dropping = { name, depth: 1, wantsLink: (name === "video" || name === "audio") && !linked };
      }
      continue;
    }

    if (!ALLOWED_ELEMENTS.has(name)) continue;
    const attributes = parseAttributes(token.attributes);

    if (name === "img") {
      const src = toUrl(attributes.get("src"), baseUrl, HTTP);
      // 計測用の画像（トラッキングピクセル）は落とす
      const alt = attributes.get("alt");
      if (!src || isTrackingImage(src, attributes)) {
        recordRemovedImage(src);
        if (imgurLink !== undefined && alt !== undefined) imgurLink.alt = decodeHTML(alt);
        continue;
      }
      if (imgurQuotes.size > 0 && canRelayImage(src)) {
        for (const quote of imgurQuotes.values()) quote.hasImage = true;
      }
      let rest = "";
      if (alt !== undefined) rest += ` alt="${escapeHtml(decodeHTML(alt))}"`;
      for (const key of ["width", "height"] as const) {
        const value = attributes.get(key);
        if (value !== undefined && DIGITS.test(value)) rest += ` ${key}="${value}"`;
      }
      parts.push({ image: src, rest });
      continue;
    }

    if (VOID_ELEMENTS.has(name)) {
      parts.push(`<${name}>`);
      continue;
    }
    if (open.length >= MAX_DEPTH) continue;

    if (name === "a") {
      // リンクの中のリンクは作らない
      closeUntil("a");
      const href = toUrl(attributes.get("href"), baseUrl, [...HTTP, "mailto:"]);
      // 行き先のないリンクは、タグを落として中身だけ残す
      if (!href) continue;
      parts.push(link(href));
      if (
        imgurQuotes.size > 0 &&
        isImgurImage(href) &&
        canRelayImage(href) &&
        !attributes.has("data-sendo-imgur-image-removed")
      ) {
        const quote = Array.from(imgurQuotes.values()).at(-1);
        if (quote !== undefined) imgurLink = { index: parts.length, href, quote };
      }
    } else {
      let extra = "";
      if (name === "blockquote") {
        const classes = decodeHTML(attributes.get("class") ?? "").split(/[\t\n\f\r ]+/);
        if (expandImgurEmbeds && classes.includes("imgur-embed-pub"))
          imgurQuotes.set(open.length + 1, { hasImage: false });
        if (attributes.get("data-embed") === "x" || classes.includes("twitter-tweet")) {
          extra = ' data-embed="x"';
        }
      }
      const numeric =
        name === "td" || name === "th" ? ["colspan", "rowspan"] : name === "ol" ? ["start"] : [];
      for (const key of numeric) {
        const value = attributes.get(key);
        if (value !== undefined && DIGITS.test(value)) extra += ` ${key}="${value}"`;
      }
      parts.push(`<${name}${extra}>`);
    }
    open.push(name);
  }

  while (open.length > 0) closeLast();
  if (!expandImgurEmbeds) return parts;
  return parts.filter(
    (part) =>
      typeof part === "string" ||
      !part.imgurFallback ||
      (!part.imgurFallback.hasImage &&
        !removedImgurImages.has(part.image.split("#", 1)[0] ?? part.image)),
  );
}

function link(href: string): string {
  return `<a href="${escapeHtml(href)}" rel="noopener noreferrer nofollow">`;
}

const image = (src: string, rest: string) => `<img src="${escapeHtml(src)}"${rest}>`;

/**
 * 外部から来た HTML をサニタイズする。リンクと画像の URL は、baseUrl を基準に絶対の URL にする。
 * 画像の URL は、もとのまま（保存するときに使う）
 */
export function sanitizeHtml(
  html: string,
  baseUrl: string,
  { expandImgurEmbeds = false }: { expandImgurEmbeds?: boolean } = {},
): string {
  return sanitizeToParts(html, baseUrl, expandImgurEmbeds)
    .map((part) => (typeof part === "string" ? part : image(part.image, part.rest)))
    .join("");
}

/**
 * サニタイズしながら、画像の URL を差し替える（返すときに使う。docs/decisions/content.md の 7）。
 * 差し替え先が null の画像は落とす
 */
export async function sanitizeHtmlWithImages(
  html: string,
  baseUrl: string,
  toImageUrl: (url: string) => Promise<string | null>,
): Promise<string> {
  const parts = await Promise.all(
    sanitizeToParts(html, baseUrl).map(async (part) => {
      if (typeof part === "string") return part;
      const src = await toImageUrl(part.image);
      return src === null ? "" : image(src, part.rest);
    }),
  );
  return parts.join("");
}

/** サニタイズした HTML に、文字のほかの中身（画像、リンク、コード、表、見出し、リストなど）があるか */
export function hasMarkupBeyondText(sanitized: string): boolean {
  return /<(?:img|a|pre|code|table|ul|ol|dl|blockquote|h[1-6]|figure)[ >]/.test(sanitized);
}
