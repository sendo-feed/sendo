import { decodeHTML } from "entities";
import { escapeHtml, parseAttributes, tokenizeHtml } from "../lib/html";

/*
 * 記事の本文を、LLM に送る断片に分け、受け取った訳から本文を組み立て直す
 * （docs/decisions/translation.md の 10）。HTML は送らず、受け取らない。
 *
 * - 入力は、サニタイズした本文（lib/sanitize-html.ts の出力。タグは必ず閉じ、属性はエスケープ
 *   してある）
 * - 文字を直接持つブロックの要素を、要素の名前によらず 1 つの断片にする。中に別のブロックがあれば、
 *   それは別の断片にする
 * - 断片の中のリンク・強調などは ⟦n⟧…⟦/n⟧、画像・改行・文の中のコードは ⟦n/⟧ の印に替える。
 *   リンクと画像の URL、pre ／ code の中身は送らない
 * - 印が欠けた・増えた・入れ子が変わった断片と、返ってこなかった断片は、原文のまま残す
 *
 * 組み立てた本文は、呼ぶ側でもう一度サニタイズしてから置く
 */

/** 文の中の要素。これ以外の要素はブロックとして扱う */
const INLINE = new Set([
  ...["a", "strong", "b", "em", "i", "u", "s", "del", "ins", "sub", "sup", "small", "mark"],
  ...["abbr", "cite", "q", "code", "kbd", "img", "br"],
]);

/** 中身を送らず、1 つの印にする文の中の要素 */
const ATOMIC = new Set(["code", "kbd", "img", "br"]);

/** 中身を持たない要素 */
const VOID = new Set(["br", "hr", "img"]);

/** 中身をまるごと送らないブロック */
const UNTRANSLATED_BLOCKS = new Set(["pre"]);

const MARKER = /⟦(\/)?(\d+)(\/)?⟧/g;

/** スキームか「//」か「www.」で始まる、空白のない文字（URL の表示） */
const URL_LIKE = /^(?:[a-z][a-z0-9+.-]*:|\/\/|www\.)\S*$/i;

/** 見えない文字（ゼロ幅の空白など） */
const INVISIBLE = /[\u200B-\u200D\u2060\uFEFF]/g;

type Node =
  | { type: "text"; raw: string }
  | { type: "element"; name: string; attributes: string; children: Node[] };

/** 断片の中の印。paired は ⟦n⟧…⟦/n⟧、atomic は ⟦n/⟧ */
interface Marker {
  node: Extract<Node, { type: "element" }>;
  paired: boolean;
  /** 外側の印の番号（なければ 0） */
  parent: number;
}

/** 断片にした、文の並び（ブロックの中の、ブロックではない子の続き） */
interface Run {
  id: string;
  nodes: Node[];
  text: string;
  markers: Map<number, Marker>;
}

export interface BodySegments {
  /** 送る断片（ID は b1、b2…） */
  segments: { id: string; text: string }[];
  /** 送る文の長さの合計（Unicode の文字） */
  length: number;
  /** 受け取った訳（ID → 訳）から本文を組み立てる。使えない訳の断片は原文のまま */
  assemble(translated: ReadonlyMap<string, string>): string;
}

/** サニタイズした本文を、送る断片に分ける */
export function splitBody(sanitized: string): BodySegments {
  const root = parse(sanitized);
  /** 断片にした並び（並びの最初のノードで引く。ノードは 1 つの並びにしか入らない） */
  const runs = new Map<Node, Run>();
  let next = 1;
  /**
   * 子を断片に分ける。hrefs は、ブロックとして扱った祖先のリンクの href（そのリンクが見せている URL
   * を、中のブロックの断片からも送らない）
   */
  const visit = (children: Node[], hrefs: readonly string[]) => {
    let pending: Node[] = [];
    const flush = () => {
      if (pending.length === 0) return;
      const run = toRun(`b${next}`, pending, hrefs);
      const first = pending[0];
      if (run !== null && first !== undefined) {
        runs.set(first, run);
        next += 1;
      }
      pending = [];
    };
    for (const child of children) {
      if (isInline(child)) {
        pending.push(child);
        continue;
      }
      flush();
      if (child.type === "element" && !UNTRANSLATED_BLOCKS.has(child.name)) {
        const href = child.name === "a" ? parseAttributes(child.attributes).get("href") : undefined;
        visit(child.children, href === undefined ? hrefs : [...hrefs, href]);
      }
    }
    flush();
  };
  visit(root, []);

  const segments = [...runs.values()].map((run) => ({ id: run.id, text: run.text }));
  return {
    segments,
    length: segments.reduce((sum, segment) => sum + [...segment.text].length, 0),
    assemble(translated) {
      const serializeChildren = (children: Node[]): string => {
        let out = "";
        let pending: Node[] = [];
        const flush = () => {
          if (pending.length === 0) return;
          const first = pending[0];
          const run = first === undefined ? undefined : runs.get(first);
          const text = run === undefined ? undefined : translated.get(run.id);
          const rebuilt = run !== undefined && text !== undefined ? rebuild(run, text) : null;
          out += rebuilt ?? pending.map(serialize).join("");
          pending = [];
        };
        for (const child of children) {
          if (isInline(child) || child.type === "text") {
            pending.push(child);
            continue;
          }
          flush();
          out += UNTRANSLATED_BLOCKS.has(child.name)
            ? serialize(child)
            : `${openTag(child)}${serializeChildren(child.children)}${closeTag(child)}`;
        }
        flush();
        return out;
      };
      return serializeChildren(root);
    },
  };
}

/** 並びを、印の付いた文にする。訳す文字がなければ null */
function toRun(id: string, nodes: Node[], hrefs: readonly string[]): Run | null {
  const markers = new Map<number, Marker>();
  let next = 1;
  let hasText = false;
  let unsafe = false;
  const encode = (list: Node[], parent: number): string => {
    let out = "";
    for (const node of list) {
      if (node.type === "text") {
        const text = decodeHTML(node.raw);
        // 印と同じ文字があると、受け取った訳の印と見分けられない。その断片は送らない
        if (/[⟦⟧]/.test(text)) unsafe = true;
        if (text.trim() !== "") hasText = true;
        out += text;
        continue;
      }
      const n = next++;
      if (isOpaque(node)) {
        markers.set(n, { node, paired: false, parent });
        out += `⟦${n}/⟧`;
      } else {
        markers.set(n, { node, paired: true, parent });
        out += `⟦${n}⟧${encode(node.children, n)}⟦/${n}⟧`;
      }
    }
    return out;
  };
  const text = encode(nodes, 0);
  if (!hasText || unsafe) return null;
  // 祖先のリンクの URL を見せる断片は送らない（リンクで包んだ段落の文字が URL のとき）
  const plain = decodeHTML(nodes.map(textOf).join("")).replace(INVISIBLE, "").trim();
  if (hrefs.some((href) => showsUrl(plain, href))) return null;
  return { id, nodes, text, markers };
}

/**
 * 受け取った訳から、並びの HTML を組み立てる。印がすべて 1 回ずつあり、入れ子（どの印の中に
 * あるか）が送ったものと同じときだけ。違えば null（原文のまま残す）
 */
function rebuild(run: Run, translated: string): string | null {
  const stack: number[] = [];
  const seen = new Set<number>();
  let out = "";
  let last = 0;
  for (const match of translated.matchAll(MARKER)) {
    out += escapeHtml(translated.slice(last, match.index));
    last = match.index + match[0].length;
    const [, closing, digits, selfClosing] = match;
    const n = Number(digits);
    const marker = run.markers.get(n);
    if (marker === undefined || (closing !== undefined && selfClosing !== undefined)) return null;
    const parent = stack.at(-1) ?? 0;
    if (closing !== undefined) {
      if (!marker.paired || stack.pop() !== n) return null;
      out += closeTag(marker.node);
      continue;
    }
    if (seen.has(n) || marker.parent !== parent) return null;
    seen.add(n);
    if (selfClosing !== undefined) {
      if (marker.paired) return null;
      out += serialize(marker.node);
    } else {
      if (!marker.paired) return null;
      stack.push(n);
      out += openTag(marker.node);
    }
  }
  out += escapeHtml(translated.slice(last));
  if (stack.length > 0 || seen.size !== run.markers.size) return null;
  return out;
}

function parse(html: string): Node[] {
  const root: Node[] = [];
  const stack: Extract<Node, { type: "element" }>[] = [];
  const children = () => stack.at(-1)?.children ?? root;
  for (const token of tokenizeHtml(html)) {
    if (token.type === "text") {
      children().push({ type: "text", raw: token.text });
      continue;
    }
    if (token.type !== "tag") continue;
    if (token.closing) {
      // サニタイズした本文なので、閉じタグは開いた順に来る。合わなければ、開いた要素まで閉じる
      const index = stack.findLastIndex((node) => node.name === token.name);
      if (index !== -1) stack.length = index;
      continue;
    }
    const node: Extract<Node, { type: "element" }> = {
      type: "element",
      name: token.name,
      attributes: token.attributes.replace(/\s*\/\s*$/, ""),
      children: [],
    };
    children().push(node);
    if (!VOID.has(token.name)) stack.push(node);
  }
  return root;
}

/**
 * 文の中のノードか。中にブロック（pre など）を持つ文の中の要素（リンクで包んだ段落など）は、
 * ブロックとして扱い、中のブロックを別の断片にする。中身を送らない要素は、いつも文の中
 */
const blockInside = new WeakMap<Node, boolean>();
function isInline(node: Node): boolean {
  if (node.type === "text") return true;
  if (ATOMIC.has(node.name)) return true;
  return INLINE.has(node.name) && !hasBlock(node);
}

function hasBlock(node: Extract<Node, { type: "element" }>): boolean {
  const cached = blockInside.get(node);
  if (cached !== undefined) return cached;
  const found = node.children.some(
    (child) =>
      child.type === "element" &&
      !ATOMIC.has(child.name) &&
      (!INLINE.has(child.name) || hasBlock(child)),
  );
  blockInside.set(node, found);
  return found;
}

/**
 * 中身を送らず、1 つの単独の印にする要素：画像・改行・文の中のコード、文字が URL のリンク、
 * 中身のない要素（落とされても断片を原文に戻さずに済むよう）
 */
function isOpaque(node: Extract<Node, { type: "element" }>): boolean {
  if (ATOMIC.has(node.name)) return true;
  const text = decodeHTML(node.children.map(textOf).join("")).replace(INVISIBLE, "").trim();
  if (text === "") return true;
  return node.name === "a" && showsUrl(text, parseAttributes(node.attributes).get("href"));
}

/**
 * リンクの文字が URL を見せているか（その URL を送らない。決定の 10、11）。スキーム ／ 「//」 ／
 * 「www.」で始まる表示か、リンク先のホスト（mailto はあて先）を含む表示なら、URL とみなす
 * （スキームを省いた表示、括弧で囲んだ表示、URL のあとに文字が続く表示も）
 */
function showsUrl(text: string, rawHref: string | undefined): boolean {
  const shown = text.replace(/^[<([]+|[>)\]]+$/g, "");
  if (URL_LIKE.test(shown)) return true;
  if (rawHref === undefined) return false;
  let href: URL;
  try {
    href = new URL(decodeHTML(rawHref));
  } catch {
    return false;
  }
  const lower = text.toLowerCase();
  if (href.protocol === "mailto:") {
    let address: string;
    try {
      address = decodeURIComponent(href.pathname);
    } catch {
      // 読めないあて先は、見せているかを確かめられないので、送らない
      return true;
    }
    return lower.includes(address.toLowerCase());
  }
  const host = href.hostname.toLowerCase().replace(/^www\./, "");
  return host !== "" && lower.includes(host);
}

/** 要素の文字（改行は空白として数える） */
function textOf(node: Node): string {
  if (node.type === "text") return node.raw;
  if (node.name === "br") return " ";
  return node.children.map(textOf).join("");
}

const openTag = (node: Extract<Node, { type: "element" }>) => `<${node.name}${node.attributes}>`;
const closeTag = (node: Extract<Node, { type: "element" }>) =>
  VOID.has(node.name) ? "" : `</${node.name}>`;

function serialize(node: Node): string {
  if (node.type === "text") return node.raw;
  return `${openTag(node)}${node.children.map(serialize).join("")}${closeTag(node)}`;
}
