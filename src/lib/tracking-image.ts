import { decodeHTML } from "entities";

/*
 * 計測用の画像（トラッキングピクセル）の見分け方（docs/decisions/content.md の 2）。
 *
 * 保存する前にも通すので、誤って落とした画像は戻らない。迷うものは残す。
 * - 大きさ：幅と高さが、ともに 1 以下と書かれた画像だけ（width ／ height の属性。style は見ない）。
 *   片方だけ、隠しただけ、style だけで小さくした画像は残す
 * - アドレス：計測のためだけに使うと、出どころを確かめたものだけ
 */

type TrackingAddress = {
  /** このホストと、そのサブドメインに当たる */
  host: string;
  /** パス（クエリを除く）の形。なければ、そのホストの画像はすべて計測用 */
  path?: RegExp;
};

/**
 * 計測のためだけに使うアドレス。足すときは、出どころ（どのサービスが、どの本文に入れるか）を
 * 書き、テスト（test/lib/sanitize-html.test.ts）も足す
 */
const TRACKING_ADDRESSES: readonly TrackingAddress[] = [
  // Feedburner の記事ごとの計測。フィードの本文の末尾に、1×1 で
  // feeds.feedburner.com/~r/<フィード>/~4/<記事> を入れる（feedproxy.google.com は同じものの別名）
  { host: "feeds.feedburner.com", path: /^\/~r\/[^/]+\/~4\// },
  { host: "feedproxy.google.com", path: /^\/~r\/[^/]+\/~4\// },
  // WordPress.com と Jetpack の統計。フィードの本文に pixel.wp.com/b.gif?…&feed=1 を入れる。
  // stats.wordpress.com は、同じ統計の前のアドレス
  { host: "pixel.wp.com" },
  { host: "stats.wordpress.com" },
  // Medium の閲覧の計測。フィードの本文の末尾に、1×1 で
  // medium.com/_/stat?event=post.clientViewed&referrerSource=full_rss&postId=… を入れる
  { host: "medium.com", path: /^\/_\/stat$/ },
  // Mailchimp のメールの開封の計測（<データセンター>.list-manage.com/track/open.php）。
  // メールの本文を写したフィード（ニュースレターの控えなど）に残ることがある
  { host: "list-manage.com", path: /^\/track\/open\.php$/ },
  // Google Analytics の計測。画像として読まれるのは、計測のためのものだけ
  { host: "google-analytics.com" },
];

/**
 * 大きさの数（「1」「1.0」「.5」など）。単位（px）と前後の空白は、除いてから当てる。
 * 外から来る値を読むので、同じ文字を取り合う量指定子を並べない（長さに比例する時間で終わる）
 */
const PIXEL_NUMBER = /^(?:\d+(?:\.\d*)?|\.\d+)$/;

/**
 * 計測用の画像か。src は絶対の URL にしたもの、attributes は parseAttributes で読んだもとの
 * 属性（名前は小文字）
 */
export function isTrackingImage(src: string, attributes: ReadonlyMap<string, string>): boolean {
  return (
    isTrackingAddress(src) ||
    (isAtMostOnePixel(attributes.get("width")) && isAtMostOnePixel(attributes.get("height")))
  );
}

function isTrackingAddress(src: string): boolean {
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    return false;
  }
  const hostname = url.hostname.toLowerCase();
  return TRACKING_ADDRESSES.some(
    ({ host, path }) =>
      (hostname === host || hostname.endsWith(`.${host}`)) &&
      (path === undefined || path.test(url.pathname)),
  );
}

/** 幅か高さの属性が 1 以下か */
function isAtMostOnePixel(attribute: string | undefined): boolean {
  if (attribute === undefined) return false;
  let value = decodeHTML(attribute).trim().toLowerCase();
  if (value.endsWith("px")) value = value.slice(0, -2).trimEnd();
  return PIXEL_NUMBER.test(value) && Number(value) <= 1;
}
