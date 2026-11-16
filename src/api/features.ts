import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { Platform } from "../platform";
import type { AuthVariables } from "./auth";
import { defaultHook } from "./hook";

const FeaturesSchema = z
  .object({
    pageContent: z.boolean().openapi({
      description:
        "記事のページから本文を抜けるか（GET /articles/{id}/content?source=page）。コンテナ版だけ",
    }),
  })
  .openapi("Features");

const featuresRoute = createRoute({
  method: "get",
  path: "/features",
  summary: "この Sendo で使える機能",
  description: [
    "Sendo には 2 つの版があり、版によって使える機能が違う（docs/decisions/container.md の 3）。",
    "クライアントは、これを見て画面を出し分ける。版の名前は返さない（機能ごとに見る）。",
  ].join("\n"),
  responses: {
    200: {
      description: "使える機能",
      content: { "application/json": { schema: FeaturesSchema } },
    },
  },
});

export function featuresApi(platform: Platform) {
  return new OpenAPIHono<{ Variables: AuthVariables }>({ defaultHook }).openapi(
    featuresRoute,
    (c) => c.json({ pageContent: platform.pageContent !== undefined }, 200),
  );
}
