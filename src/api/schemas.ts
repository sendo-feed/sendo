import { z } from "@hono/zod-openapi";
import type { ActiveBell } from "../db/bells";
import type { InboxArticle } from "../db/inbox";
import type { Feed, Folder, Workspace } from "../db/schema";
import type { SubscriptionWithFeed } from "../db/subscriptions";
import { FETCH_FEED_ERROR_CODES } from "../fetcher/fetch-feed";
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

/** 訳したモデルの説明（docs/decisions/translation.md の 18） */
export const TRANSLATION_MODEL_DESCRIPTION =
  "訳したモデル（Claude のモデルの ID。claude-sonnet-5-5 など）。応答が返したモデルで、拒否されて代わりのモデルに替わったときは代わりのモデル。同じ元記事から写した訳文は、写した元の訳文のモデル（docs/decisions/translation.md の 18）";

/**
 * 訳したときの思考量（docs/decisions/translation.md の 9、18）。Sendo の版で値が増えても読み手が
 * 壊れないよう、enum にせず文字列で返し、値は説明に書く。note は、応答ごとに null になる場合を足す
 */
export const translationEffortSchema = (note?: string) =>
  z
    .string()
    .nullable()
    .openapi({
      description: `訳したときの思考量（Claude API の effort。low ／ medium ／ high ／ xhigh ／ max）。Sendo の版によって値が増えることがあるので、読む側は知らない値もそのまま扱う。モデルと同じく、同じ元記事から写した訳文は写した元の訳文のもの（docs/decisions/translation.md の 18）。思考量を残していない訳文（思考量を残す前に送ったバッチの結果など）は null${note === undefined ? "" : `。${note}`}`,
      example: "medium",
    });

/** 設定の値。JSON の値なら何でもよく、sendo は中身を解釈しない（docs/decisions/settings.md の 2） */
export const SettingValueSchema = z.unknown().openapi({
  description: "JSON の値（オブジェクト、配列、文字列、数、真偽、null）。Sendo は中身を解釈しない",
});

export const FeedDisplayNameSchema = z.string().nullable().openapi({
  description: "この購読の表示名。null なら配信元の title（なければ URL）を使う",
});

export const FeedStatusSchema = z.enum(["active", "failing", "stalled"]).openapi({
  description:
    "Sendo からの取得状態。active は数えた失敗なし（429 を除く）、failing は失敗中、stalled は長期の失敗または HTTP 410",
});

export const FeedErrorCodeSchema = z
  .enum([...FETCH_FEED_ERROR_CODES, "invalid_feed"])
  .nullable()
  .openapi({
    description: "直近の取得失敗の理由。成功後や、理由を記録していない場合は null",
  });

export const FeedRelocationCandidateSchema = z
  .object({
    url: z.string().openapi({ description: "確認できた候補のフィード URL" }),
    title: z.string().nullable().openapi({ description: "プレーンテキストのタイトル" }),
    siteUrl: z.string().nullable(),
  })
  .nullable()
  .openapi({ description: "取得に失敗した応答から確認した移転先候補" });

export function toFeedHealthResponse(
  feed: Pick<Feed, "fetchStalled" | "errorCount" | "lastErrorCode" | "relocationCandidate">,
): {
  status: z.infer<typeof FeedStatusSchema>;
  lastErrorCode: z.infer<typeof FeedErrorCodeSchema>;
  relocationCandidate: z.infer<typeof FeedRelocationCandidateSchema>;
} {
  return {
    status: feed.fetchStalled ? "stalled" : feed.errorCount > 0 ? "failing" : "active",
    lastErrorCode: feed.lastErrorCode,
    relocationCandidate: feed.relocationCandidate,
  };
}

export const FeedSchema = z
  .object({
    id: z.string(),
    url: z.string().openapi({ example: "https://example.com/feed.xml" }),
    title: z.string().nullable(),
    displayName: FeedDisplayNameSchema,
    siteUrl: z.string().nullable(),
    iconUrl: FeedIconUrlSchema,
    folderId: z.string().nullable(),
    workspaceId: z.string().nullable().openapi({ description: "購読の所属。未割り当てなら null" }),
    subscriptionId: z.string().openapi({ description: "購読の ID。購読し直すと変わる" }),
    lastFetchedAt: dateTime.nullable().openapi({ description: "最後に取得を試した時刻" }),
    lastSuccessfulFetchAt: dateTime.nullable().openapi({
      description: "最後に成功した取得（HTTP 304 を含む）を試した時刻。記録がなければ null",
    }),
    nextFetchAt: dateTime,
    status: FeedStatusSchema,
    errorCount: z.int().nonnegative().openapi({ description: "連続した失敗の回数（429 を除く）" }),
    lastErrorCode: FeedErrorCodeSchema,
    relocationCandidate: FeedRelocationCandidateSchema,
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

export const WorkspaceSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    createdAt: dateTime,
    isDefault: z.boolean().openapi({ description: "アカウントのデフォルトか" }),
  })
  .openapi("Workspace");

export function toWorkspaceResponse(
  workspace: Pick<Workspace, "id" | "name" | "createdAt" | "isDefault">,
): z.infer<typeof WorkspaceSchema> {
  return {
    id: workspace.id,
    name: workspace.name,
    createdAt: workspace.createdAt.toISOString(),
    isDefault: workspace.isDefault,
  };
}

export const BellSchema = z
  .object({
    id: z.string(),
    subscriptionId: z
      .string()
      .nullable()
      .openapi({ description: "鳴らす購読の ID。購読し直すと変わる。購読のないベルは null" }),
    feedId: z
      .string()
      .nullable()
      .openapi({ description: "鳴らす購読のフィードの ID。購読のないベルは null" }),
    words: z.string().nullable().openapi({
      description: "当てる言葉（半角の空白区切り）。言葉のないベルは null。今は常に null",
    }),
    createdAt: dateTime,
  })
  .openapi("Bell");

export function toBellResponse(bell: ActiveBell): z.infer<typeof BellSchema> {
  return {
    id: bell.id,
    subscriptionId: bell.subscriptionId,
    feedId: bell.feedId,
    words: null,
    createdAt: bell.createdAt.toISOString(),
  };
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
    hasContent: z.boolean().openapi({
      description:
        "本文（HTML）があるか。あれば、GET /articles/{id}/content で取れる。記事を取り込んだときに決まり、あとから変わらない",
    }),
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
    displayName: subscription.displayName,
    siteUrl: feed.siteUrl,
    iconUrl: await images.toRelayUrl(feed.iconUrl),
    folderId: subscription.folderId,
    workspaceId: subscription.workspaceId,
    subscriptionId: subscription.id,
    lastFetchedAt: feed.lastFetchedAt?.toISOString() ?? null,
    lastSuccessfulFetchAt: feed.lastSuccessfulFetchAt?.toISOString() ?? null,
    nextFetchAt: feed.nextFetchAt.toISOString(),
    ...toFeedHealthResponse(feed),
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
    hasContent: article.contentKey !== null,
    publishedAt: article.publishedAt.toISOString(),
    receivedAt: article.receivedAt.toISOString(),
    readAt: article.readAt?.toISOString() ?? null,
    starredAt: article.starredAt?.toISOString() ?? null,
  };
}
