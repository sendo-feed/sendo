import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { imageSigner } from "../db/secrets";
import { FetchImageError, fetchImage } from "../fetcher/fetch-image";
import type { Platform } from "../platform";
import type { AuthVariables } from "./auth";
import { defaultHook } from "./hook";
import { ErrorSchema, errorBody } from "./schemas";

/*
 * 画像の中継（docs/decisions/images.md）。sendo-reader は CSP で画像を同じオリジンに限っているので、
 * 記事のサムネイルやフィードのアイコンを、sendo が配信元から取って返す。
 */

/** 画像の応答をキャッシュしてよい期間（秒）。URL が同じなら、中身も同じとみなす */
const MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/**
 * 画像の応答に付けるヘッダー。配信元の応答のヘッダーは写さない。
 *
 * 形式は先頭のバイトで確かめてあるが、同じオリジンで直接開かれてもスクリプトが動かないように、
 * nosniff と sandbox も重ねる
 */
const IMAGE_HEADERS = {
  "cache-control": `private, max-age=${MAX_AGE_SECONDS}`,
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; sandbox",
  "cross-origin-resource-policy": "same-origin",
};

const errorResponse = (description: string) => ({
  description,
  content: { "application/json": { schema: ErrorSchema } },
});

const imageRoute = createRoute({
  method: "get",
  path: "/images",
  summary: "画像を中継する",
  description: [
    "記事の thumbnailUrl や、フィードの iconUrl として配った URL を、そのまま開くための入口。",
    "中継するのは、sendo が署名した URL だけ。クライアントは、url と sig を自分で組み立てない。",
    "応答は Cache-Control で 30 日のキャッシュを許す。URL が同じなら中身も同じとみなしてよい。",
    "通す形式は JPEG、PNG、GIF、WebP、AVIF、ICO。SVG は通さない。",
  ].join("\n"),
  request: {
    query: z.object({
      url: z.string().max(4096).openapi({ description: "もとの画像の URL" }),
      sig: z.string().max(64).openapi({ description: "sendo が付けた署名" }),
    }),
  },
  responses: {
    200: {
      description: "画像",
      content: { "image/*": { schema: z.string().openapi({ format: "binary" }) } },
    },
    403: errorResponse("署名が合わない（sendo が配った URL ではない）"),
    502: errorResponse("配信元から取れない、画像でない、大きすぎる"),
  },
});

export function imagesApi(platform: Platform) {
  return new OpenAPIHono<{ Variables: AuthVariables }>({ defaultHook }).openapi(
    imageRoute,
    async (c) => {
      const { url, sig } = c.req.valid("query");
      if (!(await imageSigner(platform.db).verify(url, sig))) {
        return c.json(errorBody("invalid_signature", "the image URL is not signed by sendo"), 403, {
          "cache-control": "no-store",
        });
      }

      try {
        // 読者のリクエストのヘッダーは渡さない（fetchImage が、新しいリクエストを組み立てる）
        const image = await fetchImage(url, { fetch: platform.fetch });
        // c.body で返す（認証のミドルウェアが延ばしたセッションのクッキーも、一緒に返るように）
        return c.body(image.body, 200, {
          ...IMAGE_HEADERS,
          "content-type": image.contentType,
          ...(image.contentLength !== null && { "content-length": String(image.contentLength) }),
        });
      } catch (error) {
        if (!(error instanceof FetchImageError)) throw error;
        return c.json(errorBody("image_unavailable", error.message), 502, {
          "cache-control": "no-store",
        });
      }
    },
  );
}
