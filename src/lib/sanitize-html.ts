import { decodeHTML } from "entities";
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

/** サニタイズした HTML の部品。画像は、URL をあとで差し替えられるように分けて持つ */
type Part = string | { image: string; rest: string };

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

/** Imgur の公式埋め込みの引用に付く class */
const IMGUR_EMBED = "imgur-embed-pub";
const IMGUR_IMAGE_PATH = /\.(?:jpe?g|png|gif|webp|avif)$/i;

/**
 * Imgur の公式埋め込みの中のリンクが、画像の直リンクか（docs/decisions/content.md の 2）。
 * 絶対の URL にしたあとで見る。投稿やアルバムのページ（imgur.com/…）、動画、http は当たらない
 */
function isImgurImageUrl(href: string): boolean {
  const url = new URL(href);
  return (
    url.protocol === "https:" &&
    url.host === "i.imgur.com" &&
    url.username === "" &&
    url.password === "" &&
    IMGUR_IMAGE_PATH.test(url.pathname)
  );
}

const IMGUR_POST_PATH = /^\/(?:a\/|gallery\/)?[A-Za-z0-9]+$/;

/**
 * Imgur の公式埋め込みの中のリンクが、投稿やアルバムのページを指していれば、取りにいく URL
 * （クエリとハッシュを除いたもの）を返す（docs/decisions/content.md の 22）。絶対の URL にしたあとで見る
 */
function imgurPostUrl(href: string): string | null {
  const url = new URL(href);
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.host !== "imgur.com" ||
    url.username !== "" ||
    url.password !== "" ||
    !IMGUR_POST_PATH.test(url.pathname)
  ) {
    return null;
  }
  return `${url.protocol}//${url.host}${url.pathname}`;
}

/** X の公式の埋め込みコードの引用に付く class */
const X_EMBED = "twitter-tweet";
/** 投稿の ID の印（docs/decisions/content.md の 2）。sendo が付け、出力に残る */
const X_POST_ATTRIBUTE = "data-x-post";
const X_POST_HOSTS = new Set(["x.com", "twitter.com"]);
const X_POST_PATH = /^\/[A-Za-z0-9_]{1,15}\/status\/(\d{1,20})\/?$/;

/**
 * リンクが X の投稿を指していれば、その ID を返す（docs/decisions/content.md の 2）。
 * 絶対の URL にしたあとで見る。クエリとハッシュは見ない
 */
function xPostId(href: string): string | null {
  const url = new URL(href);
  if (
    url.protocol !== "https:" ||
    !X_POST_HOSTS.has(url.hostname) ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    return null;
  }
  return X_POST_PATH.exec(url.pathname)?.[1] ?? null;
}

type SanitizeOptions = {
  /**
   * Imgur の投稿のページから調べた画像（投稿のページの URL → 画像の URL）。投稿のページを書いた
   * 公式埋め込みの引用の終わりに、この画像を足す（docs/decisions/content.md の 22）
   */
  imgurPostImages?: ReadonlyMap<string, string>;
};

function sanitizeToParts(
  html: string,
  baseUrl: string,
  options: SanitizeOptions = {},
): { parts: Part[]; imgurPosts: string[] } {
  const parts: Part[] = [];
  /** 投稿のページを書いた公式埋め込みの、取りにいく URL（出てきた順、重なりなし） */
  const imgurPosts: string[] = [];
  /** 開いている（閉じタグを出していない）要素 */
  const open: string[] = [];
  /** 中身ごと落としている要素と、その入れ子の数 */
  let dropping: { name: string; depth: number; wantsLink: boolean } | null = null;
  /**
   * 開いている Imgur の公式埋め込みの引用。depth は、その引用を開いたあとの open の長さ。
   * 画像の直リンクが見つかれば image に持ち、引用の中に画像が残れば hasImage を立てる。
   * link は、引用の中で開いているリンク（depth は、リンクを開いたあとの open の長さ）。
   * 文字（空白を除く）か画像が出れば hasContent を立て、どちらもなければ閉じるときに URL を
   * 文字として出す
   */
  let imgur: {
    depth: number;
    image: string | null;
    /** 投稿やアルバムのページを書いたリンク（最初の 1 つ）の、取りにいく URL */
    post: string | null;
    hasImage: boolean;
    link: { href: string; depth: number; hasContent: boolean } | null;
  } | null = null;
  /**
   * 開いている X の引用（外側から順）。depth は、その引用を開いたあとの open の長さ、tag は
   * 開きタグの parts の位置。ids には、引用の中に出した投稿のリンクの ID を集める（入れ子の
   * 引用の中のリンクも、外側の引用で数える）。閉じるときに ID がちょうど 1 つなら、開きタグに
   * 印を付ける
   */
  const xPosts: { depth: number; tag: number; ids: Set<string> }[] = [];

  /**
   * リンクを開く。開いている X の引用には、投稿のリンクとして数える。深さの上限のところで
   * 埋め込みを替えたリンクは、もう一度通すと落ちるので、数えない（印を冪等に保つ）。
   * 知りたいのは ID がちょうど 1 つかどうかなので、引用ごとに 2 つまで集める
   */
  const pushLink = (href: string) => {
    // リンクの中で埋め込みをリンクに替えるときは、先に開いているリンクを閉じる（Imgur のリンクなら
    // URL の文字もここで出す）。入れ子のリンクは、もう一度通すと外側のリンクが分かれ、結果が変わるため
    closeUntil("a");
    parts.push(link(href));
    if (xPosts.length === 0 || open.length >= MAX_DEPTH) return;
    const id = xPostId(href);
    if (id === null) return;
    for (const quote of xPosts) if (quote.ids.size < 2) quote.ids.add(id);
  };

  /** いちばん内側の要素を閉じる。Imgur の公式埋め込みの引用なら、閉じる前に画像を足す */
  const closeTop = () => {
    if (imgur?.link && open.length === imgur.link.depth) {
      // 文字も画像もないリンクは、行き先が分かるように URL を文字にする
      if (!imgur.link.hasContent) parts.push(escapeHtml(imgur.link.href));
      imgur.link = null;
    }
    if (imgur && open.length === imgur.depth) {
      // 中のリンクは、ここまでに閉じている（画像は、リンクの外に置く）
      if (!imgur.hasImage) {
        if (imgur.image !== null) {
          parts.push({ image: imgur.image, rest: "" });
        } else if (imgur.post !== null) {
          // 直リンクがなく、画像も残らない引用だけが、投稿のページを調べる対象（決定の 22）
          if (!imgurPosts.includes(imgur.post)) imgurPosts.push(imgur.post);
          const image = options.imgurPostImages?.get(imgur.post);
          if (image !== undefined) parts.push({ image, rest: "" });
        }
      }
      imgur = null;
    }
    const quote = xPosts.at(-1);
    if (quote && open.length === quote.depth) {
      xPosts.pop();
      const [id] = quote.ids;
      if (quote.ids.size === 1) parts[quote.tag] = `<blockquote ${X_POST_ATTRIBUTE}="${id}">`;
    }
    parts.push(`</${open.pop()}>`);
  };

  const closeUntil = (name: string) => {
    const index = open.lastIndexOf(name);
    if (index === -1) return;
    while (open.length > index) closeTop();
  };

  for (const token of tokenizeHtml(html)) {
    if (token.type === "comment") continue;

    if (dropping) {
      if (token.type === "tag" && token.name === dropping.name) {
        dropping.depth += token.closing ? -1 : 1;
        if (dropping.depth === 0) dropping = null;
      } else if (dropping.wantsLink && token.type === "tag" && token.name === "source") {
        // 動画・音声の行き先が、子の <source> に書いてある場合。最初に見つかった 1 つをリンクにする
        const src = toUrl(parseAttributes(token.attributes).get("src"), baseUrl, HTTP);
        if (src) {
          pushLink(src);
          parts.push(escapeHtml(src), "</a>");
          dropping.wantsLink = false;
        }
      }
      continue;
    }

    if (token.type === "text") {
      // 文字参照を戻してから、エスケープし直す（「&lt;script&gt;」は文字のまま残る）
      const text = decodeHTML(token.text);
      parts.push(escapeHtml(text));
      if (imgur?.link && /\S/.test(text)) imgur.link.hasContent = true;
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
        if (src) {
          pushLink(src);
          parts.push(escapeHtml(src), "</a>");
        }
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
      if (!src || isTrackingImage(src, attributes)) continue;
      let rest = "";
      const alt = attributes.get("alt");
      if (alt !== undefined) rest += ` alt="${escapeHtml(decodeHTML(alt))}"`;
      for (const key of ["width", "height"] as const) {
        const value = attributes.get(key);
        if (value !== undefined && DIGITS.test(value)) rest += ` ${key}="${value}"`;
      }
      parts.push({ image: src, rest });
      if (imgur) imgur.hasImage = true;
      if (imgur?.link) imgur.link.hasContent = true;
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
      pushLink(href);
      // 当てはまるリンクがいくつもあれば、最初の 1 つを使う
      if (imgur && imgur.image === null && isImgurImageUrl(href)) imgur.image = href;
      if (imgur && imgur.post === null) imgur.post = imgurPostUrl(href);
      if (imgur) imgur.link = { href, depth: open.length + 1, hasContent: false };
    } else {
      let extra = "";
      const numeric =
        name === "td" || name === "th" ? ["colspan", "rowspan"] : name === "ol" ? ["start"] : [];
      for (const key of numeric) {
        const value = attributes.get(key);
        if (value !== undefined && DIGITS.test(value)) extra += ` ${key}="${value}"`;
      }
      parts.push(`<${name}${extra}>`);
    }
    open.push(name);
    // class は出力に残らないので、保存した本文をもう一度通しても、ここには当たらない
    if (
      name === "blockquote" &&
      imgur === null &&
      (attributes.get("class") ?? "").split(/\s+/).includes(IMGUR_EMBED)
    ) {
      imgur = { depth: open.length, image: null, post: null, hasImage: false, link: null };
    }
    // 印は出力に残るので、保存した本文をもう一度通したときは、印のある引用として調べ直す。
    // 印の値は使わず、引用の中のリンクから作り直す
    if (
      name === "blockquote" &&
      ((attributes.get("class") ?? "").split(/\s+/).includes(X_EMBED) ||
        attributes.has(X_POST_ATTRIBUTE))
    ) {
      xPosts.push({ depth: open.length, tag: parts.length - 1, ids: new Set() });
    }
  }

  while (open.length > 0) closeTop();
  return { parts, imgurPosts };
}

function link(href: string): string {
  return `<a href="${escapeHtml(href)}" rel="noopener noreferrer nofollow">`;
}

const image = (src: string, rest: string) => `<img src="${escapeHtml(src)}"${rest}>`;

/**
 * 外部から来た HTML をサニタイズする。リンクと画像の URL は、baseUrl を基準に絶対の URL にする。
 * 画像の URL は、もとのまま（保存するときに使う）
 */
export function sanitizeHtml(html: string, baseUrl: string, options?: SanitizeOptions): string {
  return sanitizeToParts(html, baseUrl, options)
    .parts.map((part) => (typeof part === "string" ? part : image(part.image, part.rest)))
    .join("");
}

/**
 * サニタイズと同じ読み方で、投稿やアルバムのページを書いた Imgur の公式埋め込みを探し、取りにいく
 * URL を出てきた順に返す（docs/decisions/content.md の 22）。見分ける手掛かりの class は、保存した
 * 本文には残らないので、抜いた HTML（最初のサニタイズの前）に使う
 */
export function findImgurPosts(html: string, baseUrl: string): string[] {
  return sanitizeToParts(html, baseUrl).imgurPosts;
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
    sanitizeToParts(html, baseUrl).parts.map(async (part) => {
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
