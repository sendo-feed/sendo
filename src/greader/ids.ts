import { ITEM_ID_LIMIT } from "../db/articles";

/*
 * Google Reader API の ID の形（docs/decisions/greader.md の 3、4）。
 */

const ITEM_ID_PREFIX = "tag:google.com,2005:reader/item/";

/** アイテムの ID の長い形（tag:google.com,2005:reader/item/ ＋ 16 桁の 16 進） */
export function toLongItemId(itemId: number): string {
  return ITEM_ID_PREFIX + itemId.toString(16).padStart(16, "0");
}

const inRange = (value: number) =>
  Number.isSafeInteger(value) && value >= 1 && value < ITEM_ID_LIMIT ? value : undefined;

/**
 * リーダーアプリが送ってきたアイテムの ID を読む。長い形、16 桁の 16 進、10 進のどれも受ける。
 * 範囲の外や、形の違うものは undefined。
 *
 * 16 文字の数字だけの値は、16 進とも 10 進とも読める。範囲内（2^53 未満）の 16 桁の 16 進は必ず
 * 00 で始まり、10 進は 0 で始まらない（10^15 以上の ID は 10 進で 16 桁になる）。そこで、16 進として
 * 読んで範囲内ならそれを採り、範囲の外なら 10 進として読む。
 */
export function parseItemId(value: string): number | undefined {
  if (value.startsWith(ITEM_ID_PREFIX)) {
    const hex = value.slice(ITEM_ID_PREFIX.length);
    return /^[0-9a-fA-F]{1,16}$/.test(hex) ? inRange(Number.parseInt(hex, 16)) : undefined;
  }
  if (/^[0-9a-fA-F]{16}$/.test(value)) {
    const hex = inRange(Number.parseInt(value, 16));
    if (hex !== undefined) return hex;
  }
  return /^[1-9][0-9]{0,15}$/.test(value) ? inRange(Number.parseInt(value, 10)) : undefined;
}

const STATE_PREFIX = "user/-/state/com.google/";
const LABEL_PREFIX = "user/-/label/";
const FEED_PREFIX = "feed/";

export const READING_LIST = `${STATE_PREFIX}reading-list`;
export const READ = `${STATE_PREFIX}read`;
export const STARRED = `${STATE_PREFIX}starred`;
export const KEPT_UNREAD = `${STATE_PREFIX}kept-unread`;

export const labelStreamId = (name: string) => LABEL_PREFIX + name;
export const feedStreamId = (feedId: string) => FEED_PREFIX + feedId;

/** ストリーム（記事の並び）の指定 */
export type Stream =
  | { kind: "reading-list" }
  | { kind: "read" }
  | { kind: "starred" }
  | { kind: "kept-unread" }
  | { kind: "label"; name: string }
  | { kind: "feed"; feedId: string };

/**
 * ストリームの ID を読む。user/<ユーザーの ID>/... の形も、user/-/... と同じに扱う。
 * 知らない形は undefined。
 */
export function parseStreamId(value: string): Stream | undefined {
  if (value.startsWith(FEED_PREFIX)) {
    const feedId = value.slice(FEED_PREFIX.length);
    return feedId === "" ? undefined : { kind: "feed", feedId };
  }
  const normalized = value.replace(/^user\/[^/]*\//, "user/-/");
  if (normalized.startsWith(LABEL_PREFIX)) {
    const name = normalized.slice(LABEL_PREFIX.length);
    return name === "" ? undefined : { kind: "label", name };
  }
  switch (normalized) {
    case READING_LIST:
      return { kind: "reading-list" };
    case READ:
      return { kind: "read" };
    case STARRED:
      return { kind: "starred" };
    case KEPT_UNREAD:
      return { kind: "kept-unread" };
    default:
      return undefined;
  }
}
