import { z } from "@hono/zod-openapi";
import type { InboxArticle } from "../db/inbox";
import type { Folder } from "../db/schema";
import type { SubscriptionWithFeed } from "../db/subscriptions";
import type { ImageSigner } from "../lib/image-url";

export const ErrorSchema = z
  .object({
    error: z.object({
      code: z.string().openapi({ example: "invalid_request" }),
      message: z.string(),
    }),
  })
  .openapi("Error");

export function errorBody(code: string, message: string) {
  return { error: { code, message } };
}

const dateTime = z.iso.datetime();

/** 中継を通る画像の URL（docs/decisions/images.md の 9） */
const relayImageUrl = (what: string) =>
  z
    .string()
    .nullable()
    .openapi({
      description: `${what}。中継を通る画像の URL（/api/v1/images?url=…&sig=… の形のパス。オリジンは付かない）で、そのまま <img src> に入れる。クライアントは組み立てたり書き換えたりしない。なければ null`,
      example: "/api/v1/images?url=https%3A%2F%2Fexample.com%2Fa.png&sig=0123456789abcdefghijkl",
    });

export const FeedIconUrlSchema = relayImageUrl("フィードのアイコン");

export const FeedSchema = z
  .object({
    id: z.string(),
    url: z.string().openapi({ example: "https://example.com/feed.xml" }),
    title: z.string().nullable(),
    siteUrl: z.string().nullable(),
    iconUrl: FeedIconUrlSchema,
    folderId: z.string().nullable(),
    lastFetchedAt: dateTime.nullable(),
    nextFetchAt: dateTime,
    errorCount: z.int().nonnegative(),
    lastError: z.string().nullable(),
    createdAt: dateTime.openapi({ description: "購読した時刻" }),
  })
  .openapi("Feed");

export const FolderSchema = z
  .object({ id: z.string(), name: z.string(), createdAt: dateTime })
  .openapi("Folder");

export function toFolderResponse(folder: Folder): z.infer<typeof FolderSchema> {
  return { id: folder.id, name: folder.name, createdAt: folder.createdAt.toISOString() };
}

export const ArticleSchema = z
  .object({
    id: z.string(),
    feedId: z.string(),
    url: z.string().nullable().openapi({ description: "http ／ https の URL だけ" }),
    title: z
      .string()
      .nullable()
      .openapi({ description: "プレーンテキスト。表示する側でエスケープすること" }),
    summary: z.string().nullable().openapi({
      description: "プレーンテキスト（最大 500 文字）。表示する側でエスケープすること",
    }),
    author: z.string().nullable(),
    thumbnailUrl: relayImageUrl("記事のサムネイル"),
    publishedAt: dateTime,
    receivedAt: dateTime.openapi({ description: "受信箱に入った時刻（サーバーの DB の時計）" }),
    readAt: dateTime.nullable().openapi({ description: "既読にした時刻。未読なら null" }),
    starredAt: dateTime.nullable().openapi({ description: "スターを付けた時刻。なければ null" }),
  })
  .openapi("Article");

/** ユーザーの購読を、フィードとして返す（id はフィードの ID。フォルダはその人のもの） */
export async function toFeedResponse(
  subscription: SubscriptionWithFeed,
  images: ImageSigner,
): Promise<z.infer<typeof FeedSchema>> {
  const { feed } = subscription;
  return {
    id: feed.id,
    url: feed.url,
    title: feed.title,
    siteUrl: feed.siteUrl,
    iconUrl: await images.toRelayUrl(feed.iconUrl),
    folderId: subscription.folderId,
    lastFetchedAt: feed.lastFetchedAt?.toISOString() ?? null,
    nextFetchAt: feed.nextFetchAt.toISOString(),
    errorCount: feed.errorCount,
    lastError: feed.lastError,
    createdAt: subscription.createdAt.toISOString(),
  };
}

export async function toArticleResponse(
  article: InboxArticle,
  images: ImageSigner,
): Promise<z.infer<typeof ArticleSchema>> {
  return {
    id: article.id,
    feedId: article.feedId,
    url: article.url,
    title: article.title,
    summary: article.summary,
    author: article.author,
    thumbnailUrl: await images.toRelayUrl(article.thumbnailUrl),
    publishedAt: article.publishedAt.toISOString(),
    receivedAt: article.receivedAt.toISOString(),
    readAt: article.readAt?.toISOString() ?? null,
    starredAt: article.starredAt?.toISOString() ?? null,
  };
}
