import { decodeHTMLAttribute } from "entities";
import { parseAttributes, tokenizeHtml } from "../lib/html";

/*
 * 記事のサムネイルを、フィードの中から採る（docs/decisions/images.md の 7）。
 * 記事のページは取りにいかない。
 */

/** 保存する画像の URL の長さの上限。これより長いものは捨てる */
export const MAX_IMAGE_URL_LENGTH = 2000;

/** 本文の HTML のうち、画像を探す範囲 */
const MAX_SCAN_LENGTH = 512 * 1024;
/** これより長いタグは読まない（属性の解析に時間をかけない） */
const MAX_TAG_LENGTH = 4096;

/** http ／ https の絶対 URL にする関数（相対 URL の基準は、呼ぶ側が決める）。だめなら null */
type Resolve = (url: string | undefined) => string | null;

/** フィードが示す画像の候補。形式ごとの違いは、呼ぶ側（parse-feed.ts）でならす */
export type ThumbnailSources = {
  /** media:thumbnail、media:content など（Media RSS） */
  media?: MediaElements | undefined;
  /** 添付（RSS の enclosure、Atom の rel="enclosure" のリンク、JSON Feed の attachments） */
  attachments?: ReadonlyArray<{ url?: string | undefined; type?: string | undefined }> | undefined;
  /** 記事の画像として示されたもの（itunes:image、JSON Feed の image など）。先のものを優先する */
  images?: ReadonlyArray<string | undefined> | undefined;
  /** 本文の HTML。先のものを優先する */
  html?: ReadonlyArray<string | undefined> | undefined;
};

type MediaContent = {
  url?: string | undefined;
  type?: string | undefined;
  medium?: string | undefined;
  thumbnails?: ReadonlyArray<{ url?: string | undefined }> | undefined;
};
type MediaElements = {
  thumbnails?: ReadonlyArray<{ url?: string | undefined }> | undefined;
  contents?: ReadonlyArray<MediaContent> | undefined;
  groups?:
    | ReadonlyArray<{
        thumbnails?: ReadonlyArray<{ url?: string | undefined }> | undefined;
        contents?: ReadonlyArray<MediaContent> | undefined;
      }>
    | undefined;
};

/**
 * サムネイルの URL を、次の順で最初に見つかったものから採る。なければ null。
 *
 * 1. media:thumbnail
 * 2. 画像の media:content
 * 3. 画像の添付
 * 4. 記事の画像として示されたもの
 * 5. 本文の HTML の最初の <img>
 */
export function pickThumbnail(sources: ThumbnailSources, resolve: Resolve): string | null {
  const first = (urls: Iterable<string | undefined>): string | null => {
    for (const url of urls) {
      const resolved = toImageUrl(url, resolve);
      if (resolved !== null) return resolved;
    }
    return null;
  };

  const { media } = sources;
  const contents = [
    ...(media?.contents ?? []),
    ...(media?.groups ?? []).flatMap((g) => g.contents ?? []),
  ];
  const thumbnails = [
    ...(media?.thumbnails ?? []),
    ...(media?.groups ?? []).flatMap((group) => group.thumbnails ?? []),
    ...contents.flatMap((content) => content.thumbnails ?? []),
  ];

  return (
    first(thumbnails.map((thumbnail) => thumbnail.url)) ??
    first(
      contents
        .filter((content) => content.medium === "image" || isImageType(content.type))
        .map((content) => content.url),
    ) ??
    first(
      (sources.attachments ?? []).filter((item) => isImageType(item.type)).map((item) => item.url),
    ) ??
    first(sources.images ?? []) ??
    first((sources.html ?? []).map((html) => firstImageSrc(html) ?? undefined))
  );
}

/** 保存してよい画像の URL にする。http ／ https でないもの、長すぎるものは null */
export function toImageUrl(url: string | undefined, resolve: Resolve): string | null {
  const resolved = resolve(url);
  return resolved !== null && resolved.length <= MAX_IMAGE_URL_LENGTH ? resolved : null;
}

function isImageType(type: string | undefined): boolean {
  return type?.trim().toLowerCase().startsWith("image/") ?? false;
}

/**
 * HTML の最初の <img> の src を返す。幅か高さが 1〜2 と書かれた画像（計測用）は飛ばす。
 *
 * 外部から来る入力なので、長さに比例する時間で読むトークナイザー（lib/html.ts）を使う。
 * コメントや script の中の <img> は読まない
 */
export function firstImageSrc(html: string | undefined): string | null {
  if (html === undefined) return null;
  for (const token of tokenizeHtml(html.slice(0, MAX_SCAN_LENGTH))) {
    if (token.type !== "tag" || token.closing || token.name !== "img") continue;
    if (token.attributes.length > MAX_TAG_LENGTH) continue;
    const attributes = parseAttributes(token.attributes);
    const src = attributes.get("src");
    if (src === undefined || src.trim() === "") continue;
    if (isTiny(attributes.get("width")) || isTiny(attributes.get("height"))) continue;
    return decodeHTMLAttribute(src);
  }
  return null;
}

function isTiny(size: string | undefined): boolean {
  return size !== undefined && /^\s*[0-2](px)?\s*$/i.test(size);
}
