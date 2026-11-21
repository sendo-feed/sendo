import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, serialize, type DefaultTreeAdapterTypes as Tree } from "parse5";
import { isTrackingImage } from "../src/lib/tracking-image";

const EMBED_HOSTS = new Set([
  "twitter.com",
  "www.twitter.com",
  "mobile.twitter.com",
  "platform.twitter.com",
  "pic.twitter.com",
  "x.com",
  "www.x.com",
  "mobile.x.com",
  "imgur.com",
  "www.imgur.com",
  "m.imgur.com",
  "i.imgur.com",
]);
const DROP_TAGS = new Set(["script", "style", "noscript"]);
const URL_ATTRS = new Set([
  "action",
  "background",
  "cite",
  "data",
  "formaction",
  "href",
  "poster",
  "src",
  "data-src",
  "data-original",
  "data-lazy-src",
  "data-href",
  "data-url",
]);
const ID_ATTRS = new Set([
  "class",
  "id",
  "for",
  "headers",
  "aria-activedescendant",
  "aria-controls",
  "aria-describedby",
  "aria-details",
  "aria-errormessage",
  "aria-flowto",
  "aria-labelledby",
  "aria-owns",
]);
const STRUCTURE_ATTRS = new Set([
  "role",
  "itemprop",
  "itemscope",
  "hidden",
  "loading",
  "width",
  "height",
  "media",
  "type",
  "lang",
  "dir",
  "rel",
  "colspan",
  "rowspan",
  "start",
  "open",
  "aria-atomic",
  "aria-busy",
  "aria-checked",
  "aria-current",
  "aria-disabled",
  "aria-expanded",
  "aria-haspopup",
  "aria-hidden",
  "aria-invalid",
  "aria-live",
  "aria-modal",
  "aria-multiselectable",
  "aria-pressed",
  "aria-readonly",
  "aria-required",
  "aria-selected",
  "aria-level",
  "aria-setsize",
  "aria-posinset",
  "aria-valuemin",
  "aria-valuemax",
  "aria-valuenow",
]);
const FILE_EXTENSION =
  /\.(?:avif|css|gif|html?|ico|jpe?g|js|json|mp4|pdf|php|png|rss|svg|webm|webp|xml)$/i;
const ASCII_SPACES = /[\t\n\f\r ]/;

function digest(seed: Buffer, value: string): Buffer {
  return createHash("sha256").update(seed).update(value).digest();
}

function range(first: number, last: number): string[] {
  return Array.from({ length: last - first + 1 }, (_, i) => String.fromCodePoint(first + i));
}

function maskTextWith(seed: Buffer) {
  const substitutions = new Map<string, string>();
  for (const [first, last] of [
    [0x61, 0x7a],
    [0x30, 0x39],
    [0xff41, 0xff5a],
    [0xff10, 0xff19],
    [0x3041, 0x3096],
    [0x30a1, 0x30fe],
    [0x4e00, 0x9fff],
    [0x3400, 0x4dbf],
  ] as const) {
    const original = range(first, last).filter((char) => !/\p{P}/u.test(char));
    const shuffled = original.slice();
    // Sattolo の方法で、同じグループ内で全ての文字を別の文字に移す。
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      const j = digest(seed, `text/${first}/${i}`).readUInt32BE() % i;
      const last = shuffled[i] ?? "";
      shuffled[i] = shuffled[j] ?? "";
      shuffled[j] = last;
    }
    for (const [i, char] of original.entries()) {
      const substitute = shuffled[i] ?? "";
      substitutions.set(char, substitute);
      if (char.toUpperCase() !== char)
        substitutions.set(char.toUpperCase(), substitute.toUpperCase());
    }
  }
  return (value: string) =>
    Array.from(value, (char) => {
      const substitute = substitutions.get(char);
      if (substitute !== undefined) return substitute;
      if (/[\p{White_Space}\p{P}]/u.test(char)) return char;
      if (/\p{Script=Han}/u.test(char)) return "仮";
      if (/\p{Script=Hiragana}/u.test(char)) return "ら";
      if (/\p{Script=Katakana}/u.test(char)) return "ラ";
      if (/\p{Lu}/u.test(char)) return "V";
      if (/\p{L}/u.test(char)) return "v";
      if (/\p{N}/u.test(char)) return "7";
      return char === "◇" ? "□" : "◇";
    }).join("");
}

function dummyPathSegment(seed: Buffer, source: string, segment: string): string {
  const extension = FILE_EXTENSION.exec(segment)?.[0] ?? "";
  let stem = "";
  const length = segment.length - extension.length;
  for (let offset = 0; offset < length; offset += 32) {
    const bytes = digest(seed, `${source}/${offset}`);
    for (const byte of bytes.subarray(0, length - offset)) {
      stem += String.fromCharCode(97 + (byte % 26));
    }
  }
  return stem + extension;
}

function embedPathSegment(
  segment: string,
  index: number,
  parts: string[],
  imgur: boolean,
  maskText: (value: string) => string,
) {
  if (segment === "") return segment;
  // a / gallery は Imgur のリンクの種類、i / web / status などは X の経路を表す。
  const route = imgur
    ? index === 1 && parts.length > 2 && ["a", "gallery", "embed"].includes(segment)
    : (index === 1 && segment === "i" && parts[2] === "web" && parts[3] === "status") ||
      (index === 2 &&
        (segment === "status" ||
          (parts[1] === "i" && segment === "web" && parts[3] === "status"))) ||
      (index === 3 && parts[1] === "i" && parts[2] === "web" && segment === "status") ||
      (index === 4 && parts[2] === "status" && ["photo", "video"].includes(segment));
  if (route) return segment;
  const extension = FILE_EXTENSION.exec(segment)?.[0] ?? "";
  return maskText(segment.slice(0, segment.length - extension.length)) + extension;
}

function maskUrlWith(seed: Buffer, page: URL, maskText: (text: string) => string) {
  return (value: string) => {
    const trimmed = value.trim();
    if (trimmed === "") return value;
    if (trimmed.startsWith("#")) return `#${maskText(trimmed.slice(1))}`;
    if (!URL.canParse(trimmed, page.href)) return "about:blank";
    const url = new URL(trimmed, page);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return url.protocol === "data:" ? "data:," : "about:blank";
    }
    const embed = EMBED_HOSTS.has(url.hostname);
    const host = embed ? url.hostname : "example.com";
    const prefix = trimmed.startsWith("//") ? "//" : `${url.protocol}//`;
    const pathname = url.pathname
      .split("/")
      .map((segment, index, parts) =>
        embed
          ? embedPathSegment(segment, index, parts, url.hostname.endsWith("imgur.com"), maskText)
          : dummyPathSegment(seed, `${url.host + url.pathname}/${index}`, segment),
      )
      .join("/");
    return prefix + host + pathname + maskText(url.search) + maskText(url.hash);
  };
}

/** URL の数と w / x の指定を保ったまま、srcset の URL だけを置き換える。 */
function maskSrcset(
  value: string,
  maskUrl: (url: string) => string,
  maskText: (value: string) => string,
): string {
  let output = "";
  let pos = 0;
  const separators = /[\t\n\f\r ,]*/y;
  while (pos < value.length) {
    const start = pos;
    separators.lastIndex = pos;
    pos += separators.exec(value)?.[0].length ?? 0;
    output += value.slice(start, pos);
    const urlStart = pos;
    while (pos < value.length && !ASCII_SPACES.test(value.charAt(pos))) pos += 1;
    const token = value.slice(urlStart, pos);
    const url = token.replace(/,+$/, "");
    if (url === "") break;
    output += maskUrl(url) + token.slice(url.length);
    if (token !== url) continue;
    const descriptors = pos;
    let parentheses = 0;
    while (pos < value.length) {
      const char = value.charAt(pos);
      if (char === "," && parentheses === 0) break;
      if (char === "(") parentheses += 1;
      if (char === ")") parentheses -= 1;
      pos += 1;
    }
    output += value
      .slice(descriptors, pos)
      .replace(/\S+/g, (descriptor) =>
        /^(?:\d+(?:\.\d+)?|\.\d+)[wx]$/.test(descriptor) ? descriptor : maskText(descriptor),
      );
  }
  return output;
}

function maskIdentifiers(
  value: string,
  terms: readonly string[],
  maskText: (value: string) => string,
) {
  for (const term of terms) {
    const pattern = new RegExp(term.replace(/[.*+?^{}$()|[\]\\]/g, "\\$&"), "giu");
    value = value.replace(pattern, maskText);
  }
  return value;
}

export function skeletonizePage(
  html: string,
  page: URL,
  siteNames: readonly string[] = [],
): string {
  const seed = createHash("sha256").update(html).digest();
  const maskText = maskTextWith(seed);
  const maskUrl = maskUrlWith(seed, page, maskText);
  const site = page.hostname.split(".").slice(-2, -1)[0] ?? "";
  const terms = [...new Set([page.hostname, site, ...siteNames])]
    .filter((term) => term.length > 0)
    .sort((a, b) => b.length - a.length);
  const doc = parse(html);

  function transform(parent: Tree.ParentNode) {
    parent.childNodes = parent.childNodes.filter((node) => {
      if ("value" in node) {
        node.value = maskText(node.value);
        return true;
      }
      if ("publicId" in node) {
        node.publicId = "";
        node.systemId = "";
        return true;
      }
      if (!("tagName" in node)) return false;
      const tag = node.tagName;
      if (DROP_TAGS.has(tag)) return false;
      if (tag === "meta") {
        if (!node.attrs.some((attr) => attr.name === "charset")) return false;
        node.attrs = [{ name: "charset", value: "utf-8" }];
        return true;
      }
      if (tag === "link" && "tagName" in parent && parent.tagName === "head") return false;
      const attributes = new Map(node.attrs.map(({ name, value }) => [name, value]));
      const src = attributes.get("src") ?? "";
      if (
        tag === "img" &&
        isTrackingImage(new URL(URL.canParse(src, page.href) ? src : "", page).href, attributes)
      ) {
        return false;
      }
      node.attrs = node.attrs.filter(
        (attr) => !attr.name.startsWith("on") && attr.name !== "srcdoc",
      );
      for (const attr of node.attrs) {
        const { name, value } = attr;
        if (ID_ATTRS.has(name)) attr.value = maskIdentifiers(value, terms, maskText);
        else if (name === "srcset" || name === "data-srcset")
          attr.value = maskSrcset(value, maskUrl, maskText);
        else if (URL_ATTRS.has(name)) attr.value = maskUrl(value);
        else if (name === "itemtype") {
          attr.value = value.replace(/\S+/g, (type) =>
            /^https?:\/\/schema\.org\/[A-Za-z0-9]+$/.test(type) ? type : maskUrl(type),
          );
        } else if (STRUCTURE_ATTRS.has(name)) attr.value = maskIdentifiers(value, terms, maskText);
        else attr.value = maskText(value);
        attr.name = maskIdentifiers(attr.name, terms, maskText);
      }
      transform(tag === "template" && "content" in node ? (node as Tree.Template).content : node);
      return true;
    });
  }

  transform(doc);
  return serialize(doc);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [input, output, url, ...siteNames] = process.argv.slice(2);
  if (!input || !output || !url || !URL.canParse(url) || resolve(input) === resolve(output)) {
    console.error(
      "使い方: node --import tsx scripts/skeletonize-page.ts <元 HTML> <出力先> <ページ URL> [掲載名 ...]",
    );
    process.exitCode = 1;
  } else {
    const bytes = await readFile(input);
    const html = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    await writeFile(output, skeletonizePage(html, new URL(url), siteNames));
  }
}
