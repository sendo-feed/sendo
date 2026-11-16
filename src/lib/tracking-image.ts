import { decodeHTML } from "entities";

/*
 * 計測用の画像（トラッキングピクセル）の見分け方（docs/decisions/content.md の 2）。
 *
 * 保存する前にも通すので、誤って落とした画像は戻らない。迷うものは残す。
 * - 大きさ：幅と高さが、ともに 1 以下と書かれた画像だけ。片方だけ、隠しただけの画像は残す
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

/*
 * 外から来る値を読むので、正規表現は、入力の長さに比例する時間で終わる形にする
 * （同じ文字を取り合う量指定子を並べない。前後の空白は、先に trim で除く）
 */

/** 大きさの数（「1」「1.0」「.5」など）。単位と前後の空白は、除いてから当てる */
const PIXEL_NUMBER = /^(?:\d+(?:\.\d*)?|\.\d+)$/;

/** style のうち、ここでは読み切れない書き方（コメント、エスケープ） */
const UNREADABLE_STYLE = /\/\*|\\/;

/** 画像の幅か高さ。style に書いてあれば、属性より style を使う（ブラウザと同じ） */
export type ImageLength = { value: string; from: "attribute" | "style" } | undefined;

export type ImageSize = { width: ImageLength; height: ImageLength };

/** 画像の幅と高さを読む。attributes は、parseAttributes で読んだもとの属性（名前は小文字） */
export function imageSize(attributes: ReadonlyMap<string, string>): ImageSize {
  const fromAttribute = (key: "width" | "height"): ImageLength => {
    const value = attributes.get(key);
    return value === undefined ? undefined : { value: decodeHTML(value), from: "attribute" };
  };
  const size: ImageSize = { width: fromAttribute("width"), height: fromAttribute("height") };
  const style = decodeHTML(attributes.get("style") ?? "");
  if (UNREADABLE_STYLE.test(style)) {
    // 読み切れない style は、大きさが分からないものとして扱う（迷うものは残す）
    return { width: { value: "", from: "style" }, height: { value: "", from: "style" } };
  }
  // あとの宣言が勝つ。ただし、!important の宣言は、!important でない宣言には負けない
  const important = { width: false, height: false };
  for (const declaration of style.split(";")) {
    const colon = declaration.indexOf(":");
    if (colon === -1) continue;
    const key = declaration.slice(0, colon).trim().toLowerCase();
    if (key !== "width" && key !== "height") continue;
    let value = declaration.slice(colon + 1).trim();
    const bang = value.lastIndexOf("!");
    const isImportant =
      bang !== -1 &&
      value
        .slice(bang + 1)
        .trim()
        .toLowerCase() === "important";
    if (isImportant) value = value.slice(0, bang).trim();
    if (important[key] && !isImportant) continue;
    size[key] = { value, from: "style" };
    important[key] = isImportant;
  }
  return size;
}

/**
 * 計測用の画像か。src は絶対の URL にしたもの、size は imageSize で読んだもの
 */
export function isTrackingImage(src: string, size: ImageSize): boolean {
  return isTrackingAddress(src) || (isAtMostOnePixel(size.width) && isAtMostOnePixel(size.height));
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

/** 幅か高さが 1 以下か */
function isAtMostOnePixel(length: ImageLength): boolean {
  if (length === undefined) return false;
  let value = length.value.trim().toLowerCase();
  if (value.endsWith("px")) value = value.slice(0, -2).trimEnd();
  return PIXEL_NUMBER.test(value) && Number(value) <= 1;
}
