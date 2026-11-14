import type { ReaderItem } from "../db/greader";
import { escapeHtml } from "../lib/html";
import { feedStreamId, labelStreamId, READ, READING_LIST, STARRED, toLongItemId } from "./ids";

/**
 * Google Reader API のアイテム（記事）の JSON。
 *
 * タイトル、要約、著者は、プレーンテキストを HTML にエスケープして入れる（docs/decisions/greader.md
 * の 6）。リーダーアプリはこれらを HTML として扱う（もとの Google Reader も、FreshRSS も、
 * 文字参照の入った HTML で返す）ので、エスケープしないとフィードの中身がマークアップとして
 * 解釈される。
 */
export function toReaderItem(item: ReaderItem, folderName: string | null) {
  const categories = [READING_LIST];
  if (item.readAt) categories.push(READ);
  if (item.starredAt) categories.push(STARRED);
  if (folderName !== null) categories.push(labelStreamId(folderName));
  const received = item.receivedAt.getTime();
  const published = Math.floor(item.publishedAt.getTime() / 1000);
  return {
    id: toLongItemId(item.itemId),
    crawlTimeMsec: String(received),
    timestampUsec: String(received * 1000),
    published,
    updated: published,
    title: escapeHtml(item.title ?? ""),
    canonical: item.url ? [{ href: item.url }] : [],
    alternate: item.url ? [{ href: item.url, type: "text/html" }] : [],
    summary: { direction: "ltr", content: escapeHtml(item.summary ?? "") },
    author: escapeHtml(item.author ?? ""),
    categories,
    origin: {
      streamId: feedStreamId(item.feedId),
      title: escapeHtml(item.feedTitle ?? item.feedUrl),
      htmlUrl: item.feedSiteUrl ?? item.feedUrl,
    },
  };
}
