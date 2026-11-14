import { OpenAPIHono } from "@hono/zod-openapi";
import type { Platform } from "../platform";
import { articlesApi } from "./articles";
import { tokenAuth } from "./auth";
import { feedsApi } from "./feeds";
import { foldersApi } from "./folders";
import { defaultHook } from "./hook";
import { opmlApi } from "./opml";

/**
 * REST API（/api/v1）。機能はすべてここから使えるようにする（API ファースト）。
 * 定義（OpenAPI）は /api/v1/openapi.json で公開する。
 */
export function createApi(platform: Platform) {
  const api = new OpenAPIHono({ defaultHook });

  // 定義は認証なしで読めるようにする（中身に秘密はない）
  api.doc31("/openapi.json", {
    openapi: "3.1.0",
    info: { title: "Sendo API", version: "0.0.0" },
    // paths は /api/v1 からの相対で書かれる。クライアントが正しい URL を組み立てられるように示す
    servers: [{ url: "/api/v1" }],
    security: [{ bearerAuth: [] }],
  });
  api.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
    type: "http",
    scheme: "bearer",
  });

  const protectedApi = new OpenAPIHono({ defaultHook });
  protectedApi.use("*", tokenAuth(platform));
  protectedApi.route("/", feedsApi(platform));
  protectedApi.route("/", articlesApi(platform));
  protectedApi.route("/", foldersApi(platform));
  protectedApi.route("/", opmlApi(platform));

  api.route("/", protectedApi);
  return api;
}
