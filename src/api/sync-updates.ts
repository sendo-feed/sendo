import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { findActiveSession } from "../db/sessions";
import type { Platform } from "../platform";
import { getSessionCookie } from "./auth";
import { defaultHook } from "./hook";

const updatesRoute = createRoute({
  method: "get",
  path: "/sync/updates",
  summary: "受信箱の更新を WebSocket で受け取る",
  description:
    '同じオリジンからセッションのクッキーで接続する。受信箱が変わると {"type":"sync_required"} が届くので、最後のカーソルから差分を取る。初回の接続時と再接続時にも差分を取る。',
  security: [{ sessionCookie: [] }],
  responses: {
    101: { description: "WebSocket 接続を開始した" },
    400: { description: "WebSocket への切り替えが必要" },
    401: { description: "有効なブラウザのセッションが必要" },
    403: { description: "公開オリジンと一致しないか、公開オリジンの設定が不正" },
    429: { description: "WebSocket の接続数の上限に達した" },
    503: { description: "サーバーは終了処理中" },
  },
});

export function syncUpdatesApi(platform: Platform) {
  return new OpenAPIHono({ defaultHook }).openapi(updatesRoute, async (c) => {
    if (c.req.header("origin") !== new URL(c.req.url).origin) {
      return c.body(null, 403);
    }
    const token = getSessionCookie(c);
    const session = token && (await findActiveSession(platform.db, { token, now: platform.now() }));
    if (!session) {
      return c.body(null, 401);
    }
    const upgradeRequested = c.req
      .header("connection")
      ?.split(",")
      .some((token) => token.trim().toLowerCase() === "upgrade");
    if (!upgradeRequested || c.req.header("upgrade")?.toLowerCase() !== "websocket") {
      return c.body(null, 400);
    }
    return platform.syncUpdates.connect(c, session);
  });
}
