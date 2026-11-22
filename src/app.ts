import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { createApi } from "./api";
import { errorBody } from "./api/schemas";
import { isStorageLimitError } from "./db/storage";
import { greaderApp } from "./greader";
import { mcpApp } from "./mcp";
import { oauthApp } from "./oauth";
import type { Platform } from "./platform";

/**
 * HTTP の入口になるアプリを組み立てる。
 *
 * 実行環境の I/O には直接触らない。必要なものは Platform として受け取る（テストで差し替える）。
 */
export function createApp(platform: Platform) {
  const app = new Hono();

  app.get("/healthz", (c) => c.json({ status: "ok" }));
  app.route("/api/v1", createApi(platform));
  // Google Reader API 互換（/accounts/ClientLogin と /reader/api/0。docs/decisions/greader.md）
  app.route("/", greaderApp(platform));
  // リモート MCP サーバー（/mcp。docs/decisions/mcp.md）
  app.route("/", mcpApp(platform));
  // OAuth の認可サーバー（メタデータ、トークン、動的登録。docs/decisions/mcp.md の 3、5）
  app.route("/", oauthApp(platform));

  app.notFound((c) => c.json(errorBody("not_found", "Not Found"), 404));

  app.onError((err, c) => {
    // 入口の検証が投げる、要求の誤り（読めない JSON の本文は 400、受け付けない Content-Type は 415）。
    // 500 にしない
    if (err instanceof HTTPException && err.status >= 400 && err.status < 500) {
      // 投げた側が応答を決めていれば（ヘッダー付きの 401 など）、それを返す
      if (err.res) return err.getResponse();
      const code = err.status === 415 ? "unsupported_media_type" : "invalid_request";
      return c.json(errorBody(code, err.message), err.status);
    }
    if (isStorageLimitError(err)) {
      console.warn("storage_limit_reached");
      return c.json(errorBody("storage_full", "Storage capacity reached"), 503);
    }
    console.error(err);
    return c.json(errorBody("internal_error", "Internal Server Error"), 500);
  });

  return app;
}
