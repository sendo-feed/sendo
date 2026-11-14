/**
 * 外部から来る HTML を読むための、小さなトークナイザー。
 *
 * ブラウザと同じ厳密さはいらないが、次の 2 つは守る。
 * - どんな入力でも、長さに比例する時間で終わる（正規表現でタグを探すと、閉じていない
 *   タグが大量にあるときに時間が二乗で増える）
 * - 引用符で囲んだ属性の値の中の「>」ではタグを閉じない。コメントと、script ／ style などの
 *   中身はタグとして読まない
 *
 * 閉じていないタグ・コメント・script などに当たったら、そこで読むのをやめる。
 */

export type HtmlToken =
  | { type: "text"; text: string }
  | { type: "tag"; name: string; closing: boolean; attributes: string }
  | { type: "comment" };

/** 中身をタグとして読まない要素。閉じタグまで丸ごと飛ばす */
const RAW_TEXT_ELEMENTS = new Set(["script", "style", "template", "textarea", "noscript"]);
const RAW_TEXT_CLOSE = new Map(
  [...RAW_TEXT_ELEMENTS].map((name) => [name, new RegExp(`</${name}\\s*>`, "gi")]),
);

const TAG_NAME = /^\/?([a-zA-Z][a-zA-Z0-9:-]*)/;
const TAG_START = /[a-zA-Z/!?]/;

export function* tokenizeHtml(html: string): Generator<HtmlToken> {
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      yield { type: "text", text: html.slice(i) };
      return;
    }
    if (lt > i) yield { type: "text", text: html.slice(i, lt) };

    // 「x < y」のように、「<」の次が英字などでなければ文字として扱う
    if (!TAG_START.test(html[lt + 1] ?? "")) {
      yield { type: "text", text: "<" };
      i = lt + 1;
      continue;
    }

    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      if (end === -1) return;
      yield { type: "comment" };
      i = end + 3;
      continue;
    }

    const end = findTagEnd(html, lt + 1);
    if (end === -1) return;
    const inner = html.slice(lt + 1, end);
    const match = TAG_NAME.exec(inner);
    const name = match?.[1]?.toLowerCase() ?? "";
    const closing = inner.startsWith("/");
    yield { type: "tag", name, closing, attributes: inner.slice(match?.[0].length ?? 0) };
    i = end + 1;

    const close = closing ? undefined : RAW_TEXT_CLOSE.get(name);
    if (close) {
      close.lastIndex = i;
      const found = close.exec(html);
      if (found === null) return;
      yield { type: "tag", name, closing: true, attributes: "" };
      i = found.index + found[0].length;
    }
  }
}

/**
 * タグの終わり（「>」）の位置を返す。「=」のあとの引用符で囲んだ値の中の「>」は飛ばす。
 * 見つからなければ -1。
 */
function findTagEnd(html: string, from: number): number {
  let i = from;
  while (i < html.length) {
    const char = html[i];
    if (char === ">") return i;
    i++;
    if (char !== "=") continue;

    while (i < html.length && /\s/.test(html[i] ?? "")) i++;
    const quote = html[i];
    if (quote === '"' || quote === "'") {
      const close = html.indexOf(quote, i + 1);
      if (close === -1) return -1;
      i = close + 1;
    }
  }
  return -1;
}

/** タグとコメントを空白に置き換え、script などの中身を除く */
export function stripTags(html: string): string {
  let out = "";
  for (const token of tokenizeHtml(html)) out += token.type === "text" ? token.text : " ";
  return out;
}

/** タグの中の属性を読む（名前は小文字にする）。同じ名前は最初のものを使う。値の文字参照は戻さない */
export function parseAttributes(source: string): Map<string, string> {
  const attributes = new Map<string, string>();
  const pattern = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const [, name, double, single, bare] of source.matchAll(pattern)) {
    if (name === undefined) continue;
    const key = name.toLowerCase();
    if (!attributes.has(key)) attributes.set(key, double ?? single ?? bare ?? "");
  }
  return attributes;
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/**
 * プレーンテキストを、HTML の中に置いてもマークアップとして解釈されない形にする。
 * 外から来た文字列（記事のタイトルや要約）を、HTML として表示する相手に渡すときに使う。
 */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}
