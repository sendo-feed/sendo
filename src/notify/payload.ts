import { MAX_PUSH_PAYLOAD_BYTES } from "./web-push";

/*
 * ベルの通知の中身（docs/decisions/notifications.md の 14〜16）。Declarative Web Push の JSON にする。
 * フィード名とタイトルは信頼できないデータとして、文字のまま JSON の文字列に入れる。手を加えるのは
 * 長さの切り詰めだけ。
 */

/** フィード名を切る長さ（コードポイント） */
export const MAX_FEED_NAME_LENGTH = 80;

/** 記事のタイトル（なければ要約の先頭）を 1 件ごとに切る長さ（コードポイント） */
export const MAX_ARTICLE_TITLE_LENGTH = 200;

/** まとめの本文に並べるタイトルの数 */
export const BUNDLE_LINES = 3;

/** タイトルや名前を切ったときに付ける印 */
const ELLIPSIS = "…";

export type NotificationArticle = { id: string; title: string | null; summary: string | null };

/** 通知 1 つの中身。送るときに、通知の行から組み立てる */
export type BellNotification = {
  bellId: string;
  /** ベルの言葉。言葉のないベルは null */
  words: string | null;
  /** フィード名（空にしない）。言葉だけのベルのまとめは null */
  feedName: string | null;
  /**
   * 載せる記事。新しい順で、1 件以上。1 件ずつの通知は 1 件、まとめは本文に並べる候補
   * （BUNDLE_LINES 件まで）
   */
  articles: readonly NotificationArticle[];
  /** まとめた記事の数。1 件ずつの通知は 1 */
  count: number;
  /** 送るときの、受信箱の未読の合計 */
  unread: number;
};

const encoder = new TextEncoder();

/** コードポイントで limit を超えていたら、limit で切って印を付ける */
function shorten(text: string, limit: number): string {
  const codePoints = Array.from(text);
  return codePoints.length <= limit ? text : codePoints.slice(0, limit).join("") + ELLIPSIS;
}

const lengthOf = (text: string) => Array.from(text).length;

/**
 * 通知の JSON（暗号化の前の中身）を作る。3993 バイト（MAX_PUSH_PAYLOAD_BYTES）に収める。
 *
 * 先にフィード名を 80、記事のタイトルを 1 件 200 コードポイントで切る。それでも超えたら、まとめの本文
 * に並べるタイトルを 1 件ずつ減らし（減らした分は「ほか n 件」に入れる）、まだ超えれば、記事の
 * タイトル、フィード名の順に半分ずつ切り詰める
 */
export function buildNotificationPayload(
  notification: BellNotification,
  readerOrigin: string,
): string {
  const { bellId, words, feedName, count, unread } = notification;
  const [newest] = notification.articles;
  if (newest === undefined) throw new Error("a notification needs an article");
  const titles = notification.articles
    .slice(0, BUNDLE_LINES)
    .map((article) => article.title ?? article.summary ?? "");
  const navigate = new URL(`/?article=${encodeURIComponent(newest.id)}`, readerOrigin).href;

  let shown = titles.length;
  let titleLimit = MAX_ARTICLE_TITLE_LENGTH;
  let feedLimit = MAX_FEED_NAME_LENGTH;
  for (;;) {
    const rest = count - shown;
    const lines = titles.slice(0, shown).map((title) => shorten(title, titleLimit));
    if (rest > 0) lines.push(`ほか ${rest} 件`);
    const feed = feedName === null ? null : shorten(feedName, feedLimit);
    const json = JSON.stringify({
      web_push: 8030,
      notification: {
        title: [words, feed].filter((part) => part !== null).join(" · "),
        body: lines.join("\n"),
        navigate,
        tag: `bell:${bellId}:${newest.id}`,
        data: { bellId, articleId: newest.id, count },
      },
      app_badge: unread,
      mutable: true,
    });
    if (encoder.encode(json).length <= MAX_PUSH_PAYLOAD_BYTES) return json;

    // 減らすのは並べるタイトルの数から。いちばん新しい記事のタイトルを残す
    if (shown > 1) shown--;
    else if (titleLimit > 0)
      titleLimit = Math.floor(Math.min(titleLimit, lengthOf(titles[0] ?? "")) / 2);
    else if (feedName !== null && feedLimit > 0) {
      feedLimit = Math.floor(Math.min(feedLimit, lengthOf(feedName)) / 2);
    } else throw new Error("notification does not fit in a push message");
  }
}
