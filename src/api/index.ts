import { OpenAPIHono } from "@hono/zod-openapi";
import type { Platform } from "../platform";
import { articlesApi } from "./articles";
import { authenticate, SESSION_COOKIE } from "./auth";
import { feedsApi } from "./feeds";
import { foldersApi } from "./folders";
import { defaultHook } from "./hook";
import { loginApi } from "./login";
import { meApi } from "./me";
import { opmlApi } from "./opml";
import { syncApi } from "./sync";
import { tokensApi } from "./tokens";

/** OpenAPI の定義の、paths 以外の部分。/api/v1/openapi.json と spec/openapi.json で同じものを使う */
export const OPENAPI_CONFIG = {
  openapi: "3.1.0",
  info: { title: "Sendo API", version: "0.0.0" },
  // paths は /api/v1 からの相対で書かれる。クライアントが正しい URL を組み立てられるように示す
  servers: [{ url: "/api/v1" }],
  // アクセストークンか、ブラウザのセッションのクッキーのどちらか
  security: [{ bearerAuth: [] }, { sessionCookie: [] }],
};

/**
 * REST API（/api/v1）。機能はすべてここから使えるようにする（API ファースト）。
 * 定義（OpenAPI）は /api/v1/openapi.json で公開し、spec/openapi.json にも書き出す
 * （pnpm openapi:generate。sendo-reader が型を作るのに使う）。
 */
export function createApi(platform: Platform) {
  const api = new OpenAPIHono({ defaultHook });

  // 定義は認証なしで読めるようにする（中身に秘密はない）
  api.doc31("/openapi.json", OPENAPI_CONFIG);
  api.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
    type: "http",
    scheme: "bearer",
    description: "アクセストークン（sendo_ で始まる）",
  });
  api.openAPIRegistry.registerComponent("securitySchemes", "sessionCookie", {
    type: "apiKey",
    in: "cookie",
    name: `__Host-${SESSION_COOKIE}`,
    description:
      "ブラウザのセッション（/auth/{provider}/login でログインすると置かれる）。状態を変えるリクエストは、同じオリジンのページからだけ受ける",
  });

  // 認証の要らない入口は、認証のミドルウェアより先に登録する（あとに登録したものには、
  // protectedApi の use("*") がかかる）
  api.route("/", loginApi(platform));

  const protectedApi = new OpenAPIHono({ defaultHook });
  protectedApi.use("*", authenticate(platform));
  protectedApi.route("/", meApi());
  protectedApi.route("/", feedsApi(platform));
  protectedApi.route("/", articlesApi(platform));
  protectedApi.route("/", foldersApi(platform));
  protectedApi.route("/", opmlApi(platform));
  protectedApi.route("/", syncApi(platform));
  protectedApi.route("/", tokensApi(platform));

  api.route("/", protectedApi);
  return api;
}
