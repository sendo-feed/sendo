import { z } from "@hono/zod-openapi";
import type { Article, Feed, Folder } from "../db/schema";

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

export const FeedSchema = z
  .object({
    id: z.string(),
    url: z.string().openapi({ example: "https://example.com/feed.xml" }),
    title: z.string().nullable(),
    siteUrl: z.string().nullable(),
    folderId: z.string().nullable(),
    lastFetchedAt: dateTime.nullable(),
    nextFetchAt: dateTime,
    errorCount: z.int().nonnegative(),
    lastError: z.string().nullable(),
    createdAt: dateTime,
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
    publishedAt: dateTime,
    createdAt: dateTime,
    readAt: dateTime.nullable().openapi({ description: "既読にした時刻。未読なら null" }),
    starredAt: dateTime.nullable().openapi({ description: "スターを付けた時刻。なければ null" }),
  })
  .openapi("Article");

export function toFeedResponse(feed: Feed): z.infer<typeof FeedSchema> {
  return {
    id: feed.id,
    url: feed.url,
    title: feed.title,
    siteUrl: feed.siteUrl,
    folderId: feed.folderId,
    lastFetchedAt: feed.lastFetchedAt?.toISOString() ?? null,
    nextFetchAt: feed.nextFetchAt.toISOString(),
    errorCount: feed.errorCount,
    lastError: feed.lastError,
    createdAt: feed.createdAt.toISOString(),
  };
}

export function toArticleResponse(article: Article): z.infer<typeof ArticleSchema> {
  return {
    id: article.id,
    feedId: article.feedId,
    url: article.url,
    title: article.title,
    summary: article.summary,
    author: article.author,
    publishedAt: article.publishedAt.toISOString(),
    createdAt: article.createdAt.toISOString(),
    readAt: article.readAt?.toISOString() ?? null,
    starredAt: article.starredAt?.toISOString() ?? null,
  };
}
