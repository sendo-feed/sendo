import { Hono } from "hono";
import { createApi } from "./api";
import { errorBody } from "./api/schemas";
import { greaderApp } from "./greader";
import type { Platform } from "./platform";

/**
 * HTTP の入口になるアプリを組み立てる。
 *
 * 実行環境（Cloudflare など）には依存させない。必要なものは Platform として受け取る。
 */
export function createApp(platform: Platform) {
  const app = new Hono();

  app.get("/healthz", (c) => c.json({ status: "ok" }));
  app.route("/api/v1", createApi(platform));
  // Google Reader API 互換（/accounts/ClientLogin と /reader/api/0。docs/decisions/greader.md）
  app.route("/", greaderApp(platform));

  app.notFound((c) => c.json(errorBody("not_found", "Not Found"), 404));

  app.onError((err, c) => {
    console.error(err);
    return c.json(errorBody("internal_error", "Internal Server Error"), 500);
  });

  return app;
}
