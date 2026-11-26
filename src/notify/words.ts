import type { BellTarget, BellWords } from "../db/bells";

/*
 * ベルの言葉（docs/decisions/notifications.md の 6、7）。受けた文字列を NFKC にしてから空白で区切り、
 * 区切った言葉がすべて記事にあれば当てる（AND）。比べるときは、言葉と記事の文字を NFKC にして
 * 小文字にし、ASCII の英数字の端だけ、前後に英数字が続かないかを見る。
 */

/** 1 つのベルの言葉の数の上限 */
export const MAX_BELL_WORDS = 8;

/** 言葉の全体の長さの上限（保存する形の、区切りの空白を含むコードポイントの数） */
export const MAX_BELL_WORDS_LENGTH = 64;

/**
 * 受ける文字列の長さの上限（UTF-16 の単位）。NFKC で縮む文字（半角のカナと濁点など）、重なる言葉、
 * 余分な空白の分を見込んで、保存する形の上限より大きくとる。超えたら、正規化する前に断る
 */
export const MAX_BELL_WORDS_INPUT_LENGTH = 1024;

/** 言葉を受けられない理由 */
export type BellWordsProblem = "empty" | "too_many_words" | "too_long" | "invalid_character";

/** 理由ごとの説明。REST API と MCP のエラーに入れる */
export const BELL_WORDS_PROBLEMS: Record<BellWordsProblem, string> = {
  empty: "words must contain at least one word",
  too_many_words: `words must contain at most ${MAX_BELL_WORDS} words`,
  too_long: `words must be at most ${MAX_BELL_WORDS_LENGTH} characters`,
  invalid_character: "words must not contain control characters or unpaired surrogates",
};

/** 空白（\s に当たる文字。全角の空白、タブ、改行を含む）の並び */
const SEPARATOR = /\s+/;

/** 制御文字。区切りの空白（タブ、改行など）は、区切ったあとの言葉には残らない */
const CONTROL = /\p{Cc}/u;

/**
 * 受けた文字列を、保存する言葉の形にする。NFKC にしてから空白の並びで区切り、小文字にして同じに
 * なる言葉は最初のものだけを残す。数と長さは、重なりを除いた形で数える
 *
 * @returns 保存する形。受けられなければ、その理由
 */
export function parseBellWords(input: string): BellWords | BellWordsProblem {
  if (input.length > MAX_BELL_WORDS_INPUT_LENGTH) return "too_long";
  const kept: string[] = [];
  const lowered = new Set<string>();
  for (const word of input.normalize("NFKC").split(SEPARATOR)) {
    const lower = word.toLowerCase();
    if (word === "" || lowered.has(lower)) continue;
    kept.push(word);
    lowered.add(lower);
  }
  if (kept.length === 0) return "empty";
  if (kept.some((word) => CONTROL.test(word) || !word.isWellFormed())) return "invalid_character";
  if (kept.length > MAX_BELL_WORDS) return "too_many_words";
  const words = kept.join(" ");
  if (Array.from(words).length > MAX_BELL_WORDS_LENGTH) return "too_long";
  return { words, matchKey: [...lowered].sort(compareCodePoints).join(" ") };
}

/**
 * REST API と MCP の入力（`feedId` と `words`）から、付けるベルの組を作る。
 *
 * @returns 付ける組。どちらもなければ missing、言葉を受けられなければその理由
 */
export function parseBellTarget(input: {
  feedId?: string | undefined;
  words?: string | undefined;
}): BellTarget | "missing" | BellWordsProblem {
  const words = input.words === undefined ? null : parseBellWords(input.words);
  if (typeof words === "string") return words;
  if (input.feedId !== undefined) return { feedId: input.feedId, words };
  return words === null ? "missing" : { feedId: null, words };
}

/** 記事の文字を、言葉と比べる形にする（NFKC にしてから小文字にする） */
export function toMatchText(text: string): string {
  return text.normalize("NFKC").toLowerCase();
}

/**
 * 照合用の言葉（match_key）の言葉が、すべて text にあるか。text は toMatchText にしたもの
 */
export function matchesBellWords(text: string, matchKey: string): boolean {
  return matchKey.split(" ").every((word) => containsWord(text, word));
}

/**
 * text に word があるか。word が ASCII の英数字で始まるなら、すぐ前に英数字のある箇所には当てない。
 * 英数字で終わるなら、すぐあとに英数字のある箇所には当てない（「Go」は「Google」に当たらず、
 * 「Go言語」には当たる）。日本語や記号の端では、前後を見ない
 */
function containsWord(text: string, word: string): boolean {
  const checkStart = isAsciiAlphanumeric(word.charCodeAt(0));
  const checkEnd = isAsciiAlphanumeric(word.charCodeAt(word.length - 1));
  for (let at = text.indexOf(word); at !== -1; at = text.indexOf(word, at + 1)) {
    if (checkStart && isAsciiAlphanumeric(text.charCodeAt(at - 1))) continue;
    if (checkEnd && isAsciiAlphanumeric(text.charCodeAt(at + word.length))) continue;
    return true;
  }
  return false;
}

/** ASCII の英字か数字か。文字列の外（NaN）は英数字ではない */
function isAsciiAlphanumeric(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

/** コードポイントの順に比べる（文字列の既定の比べ方は UTF-16 の単位の順で、サロゲートの扱いが違う） */
function compareCodePoints(a: string, b: string): number {
  const left = a[Symbol.iterator]();
  const right = b[Symbol.iterator]();
  for (;;) {
    const l = left.next();
    const r = right.next();
    if (l.done || r.done) return (l.done ? 0 : 1) - (r.done ? 0 : 1);
    const diff = (l.value.codePointAt(0) ?? 0) - (r.value.codePointAt(0) ?? 0);
    if (diff !== 0) return diff;
  }
}
