import { Hono } from "hono";

/**
 * HTTP の入口になるアプリを組み立てる。
 *
 * 実行環境（Cloudflare など）には依存させない。必要になったものは、
 * src/platform/ のインターフェースとして引数で受け取る。
 */
export function createApp() {
  const app = new Hono();

  app.get("/healthz", (c) => c.json({ status: "ok" }));

  app.notFound((c) => c.json({ error: { code: "not_found", message: "Not Found" } }, 404));

  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: { code: "internal_error", message: "Internal Server Error" } }, 500);
  });

  return app;
}
