import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { AuthVariables } from "./auth";
import { defaultHook } from "./hook";

const FeaturesSchema = z
  .object({
    languageDetection: z.boolean().openapi({
      description: "記事の主言語を背景で判定・保存できるか。常に true",
    }),
    pageContent: z.boolean().openapi({
      description:
        "記事のページから本文を抜けるか（GET /articles/{id}/content?source=page）。常に true",
    }),
    syncUpdates: z.boolean().openapi({
      description:
        "Sendo が WebSocket 通知に対応しているか（GET /sync/updates）。対応前の Sendo はこの項目を返さない",
    }),
  })
  .openapi("Features");

const featuresRoute = createRoute({
  method: "get",
  path: "/features",
  summary: "この Sendo で使える機能",
  description: [
    "使える機能を返す。今はどの機能も常に使えるので、すべて true を返す。",
    "sendo-reader の互換のために残している。sendo-reader が使わなくなったら消す（docs/decisions/container.md の 3）。",
  ].join("\n"),
  responses: {
    200: {
      description: "使える機能",
      content: { "application/json": { schema: FeaturesSchema } },
    },
  },
});

export function featuresApi() {
  return new OpenAPIHono<{ Variables: AuthVariables }>({ defaultHook }).openapi(
    featuresRoute,
    (c) => c.json({ pageContent: true, languageDetection: true, syncUpdates: true }, 200),
  );
}
