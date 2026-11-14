import { generateOpml, type Opml, parseOpml } from "feedsmith";
import { normalizeFolderName } from "../db/folders";
import { toFetchableUrl, UrlNotAllowedError } from "../fetcher/url-guard";

/** OPML から取り出した、購読する 1 件 */
export type OpmlEntry = { url: string; folder: string | null };

export type OpmlSkip = {
  url: string;
  reason: "url_not_allowed" | "url_too_long" | "duplicate" | "too_many";
};

export class OpmlError extends Error {
  override readonly name = "OpmlError";
}

/** 1 回のインポートで受け付けるフィードの上限 */
export const MAX_OPML_FEEDS = 5000;
export const MAX_URL_LENGTH = 2048;
/** 入れ子の深さの上限。これより深い outline は読まない */
const MAX_DEPTH = 32;

type Outline = Opml.Outline<string>;

/**
 * OPML から購読するフィードを取り出す。
 *
 * - xmlUrl を持つ outline をフィード、持たずに子を持つ outline をフォルダとみなす
 * - フォルダが入れ子なら、いちばん近いフォルダに入れる（Sendo のフォルダは 1 段だけ）
 * - URL は取得してよいかを確かめて正規化し、同じ URL は最初の 1 件だけを残す
 */
export function readOpml(xml: string): { entries: OpmlEntry[]; skipped: OpmlSkip[] } {
  let document: Opml.Document<string>;
  try {
    document = parseOpml(xml);
  } catch (error) {
    throw new OpmlError(error instanceof Error ? error.message : String(error));
  }

  const entries: OpmlEntry[] = [];
  const skipped: OpmlSkip[] = [];
  const seen = new Set<string>();

  // 深い入れ子で再帰が溢れないように、スタックでたどる
  const stack: { outline: Outline; folder: string | null; depth: number }[] = (
    document.body?.outlines ?? []
  )
    .map((outline) => ({ outline, folder: null, depth: 0 }))
    .reverse();

  while (stack.length > 0) {
    const item = stack.pop();
    if (!item) break;
    const { outline, folder, depth } = item;

    if (outline.xmlUrl !== undefined) {
      const raw = outline.xmlUrl.trim();
      if (raw === "") continue;
      if (entries.length >= MAX_OPML_FEEDS) {
        skipped.push({ url: raw, reason: "too_many" });
        continue;
      }
      let url: string;
      try {
        url = toFetchableUrl(raw).href;
      } catch (error) {
        if (!(error instanceof UrlNotAllowedError)) throw error;
        skipped.push({ url: raw.slice(0, MAX_URL_LENGTH), reason: "url_not_allowed" });
        continue;
      }
      // 日本語などはパーセントエンコードで長くなるので、正規化したあとの長さで判定する
      if (url.length > MAX_URL_LENGTH) {
        skipped.push({ url: url.slice(0, MAX_URL_LENGTH), reason: "url_too_long" });
        continue;
      }
      if (seen.has(url)) {
        skipped.push({ url, reason: "duplicate" });
        continue;
      }
      seen.add(url);
      entries.push({ url, folder });
      continue;
    }

    if (outline.outlines && depth < MAX_DEPTH) {
      const name = normalizeFolderName(outline.title ?? outline.text) ?? folder;
      for (const child of [...outline.outlines].reverse()) {
        stack.push({ outline: child, folder: name, depth: depth + 1 });
      }
    }
  }

  return { entries, skipped };
}

/** OPML に書き出す 1 件 */
export type OpmlFeed = {
  url: string;
  title: string | null;
  siteUrl: string | null;
  folderName: string | null;
};

/** 購読しているフィードを OPML 2.0 にする。フォルダなしのフィードは最上位に置く */
export function writeOpml(feeds: readonly OpmlFeed[], now: Date): string {
  const toOutline = (feed: OpmlFeed): Outline => ({
    type: "rss",
    text: feed.title ?? feed.url,
    ...(feed.title !== null && { title: feed.title }),
    xmlUrl: feed.url,
    ...(feed.siteUrl !== null && { htmlUrl: feed.siteUrl }),
  });

  const byFolder = new Map<string, Outline[]>();
  const topLevel: Outline[] = [];
  for (const feed of feeds) {
    if (feed.folderName === null) {
      topLevel.push(toOutline(feed));
      continue;
    }
    const list = byFolder.get(feed.folderName) ?? [];
    list.push(toOutline(feed));
    byFolder.set(feed.folderName, list);
  }

  const folderOutlines: Outline[] = [...byFolder].map(([name, outlines]) => ({
    text: name,
    title: name,
    outlines,
  }));

  return generateOpml({
    head: { title: "Sendo subscriptions", dateCreated: now },
    body: { outlines: [...folderOutlines, ...topLevel] },
  });
}
