/**
 * Imgur の公式埋め込みのうち、投稿やアルバムのページを書いた形は、投稿のページを 1 段だけ調べ、
 * 本文に足す画像を決める（docs/decisions/content.md の 22）。
 *
 * - 投稿のページは、記事のページと同じ守りで取る（fetchPage。SSRF の確認、大きさと時間の上限、
 *   リダイレクトの行き先ごとの robots.txt）。ホストごとの順番は、呼ぶ側の run で待つ
 * - 回数・本体の大きさ・期限は、拡大画像（20）と導入の画像（21）と 1 つの上限（PageFetchBudget）を
 *   分け合い、ここが先に使う
 * - 画像そのものは取らない。返すときに中継が取って確かめる（docs/decisions/images.md の 5）
 */
import { decodeHTML } from "entities";
import { parseAttributes, tokenizeHtml } from "../lib/html";
import { fetchPage } from "./fetch-page";
import type { PageFetchBudget } from "./page-images";

/** 記事 1 件で取る投稿のページの数 */
export const IMGUR_POST_LIMIT = 12;

/** 投稿のページの大きさの上限（記事のページと同じ。決定の 12） */
const POST_PAGE_MAX_BYTES = 3 * 1024 * 1024;

const OG_IMAGE_PATH = /^\/[A-Za-z0-9]+\.(?:jpe?g|png|gif|webp|avif)$/i;
const TWITTER_IMAGE_PATH = /^\/[A-Za-z0-9]+h\.jpg$/;

/** `https://i.imgur.com/<id>…` の形（ポートと認証情報なし）なら、その URL を返す。クエリとハッシュは見ない */
function imgurImageUrl(value: string | undefined, path: RegExp): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (!URL.canParse(trimmed)) return null;
  const url = new URL(trimmed);
  if (
    url.protocol !== "https:" ||
    url.host !== "i.imgur.com" ||
    url.username !== "" ||
    url.password !== "" ||
    !path.test(url.pathname)
  ) {
    return null;
  }
  return url.href;
}

/**
 * 投稿のページの HTML から、本文に足す画像の URL を決める。`og:type` が `article`（画像とアルバム）なら
 * `og:image`（元の画像。アルバムは表紙）、`video.other`（動画）なら `twitter:image`（静止画）。
 * それ以外の種類、値がない、形が合わない（消えた投稿の、id のない値を含む）ときは null
 */
export function imgurImageFromPage(html: string): string | null {
  const meta = new Map<string, string>();
  for (const token of tokenizeHtml(html)) {
    if (token.type !== "tag" || token.closing || token.name !== "meta") continue;
    const attributes = parseAttributes(token.attributes);
    const property = attributes.get("property");
    const name = attributes.get("name");
    // og:* は property、twitter:* は name で探す。同じものが複数あれば最初の 1 つ
    const key = property?.startsWith("og:")
      ? property
      : name?.startsWith("twitter:")
        ? name
        : undefined;
    const content = attributes.get("content");
    if (key === undefined || content === undefined || meta.has(key)) continue;
    meta.set(key, decodeHTML(content));
  }
  switch (meta.get("og:type")?.trim()) {
    case "article":
      return imgurImageUrl(meta.get("og:image"), OG_IMAGE_PATH);
    case "video.other":
      return imgurImageUrl(meta.get("twitter:image"), TWITTER_IMAGE_PATH);
    default:
      return null;
  }
}

type Options = {
  budget: PageFetchBudget;
  isAllowed: (url: URL, fetcher: typeof fetch, signal: AbortSignal) => Promise<boolean>;
  /** 記事のページと同じ HostGate に並ぶ。robots.txt とリダイレクトもこの中で行う */
  run: <T>(url: string, task: () => Promise<T>) => Promise<T>;
};

/**
 * 投稿のページを 1 件ずつ取り、足す画像を決める（投稿のページの URL → 画像の URL）。取れなかった
 * （robots.txt で許されていない、失敗した、上限を超えた）投稿は、結果に入れない
 */
export async function resolveImgurPosts(
  posts: readonly string[],
  options: Options,
): Promise<Map<string, string>> {
  const { budget } = options;
  const images = new Map<string, string>();
  for (const post of posts.slice(0, IMGUR_POST_LIMIT)) {
    if (budget.exhausted()) break;
    try {
      const page = await options.run(post, async () => {
        // 順番が来ても、期限が切れていれば取りにいかない
        budget.signal.throwIfAborted();
        return fetchPage(post, {
          fetch: budget.resourceFetch,
          maxBytes: Math.min(POST_PAGE_MAX_BYTES, budget.remainingBytes()),
          isAllowed: (target) => options.isAllowed(target, budget.fetch, budget.signal),
        });
      });
      const image = imgurImageFromPage(new TextDecoder().decode(page.bytes));
      if (image !== null) images.set(post, image);
    } catch {
      // robots 不許可、404、時間切れ、上限切れなどでも、本文はリンクのまま残す
    }
  }
  return images;
}
