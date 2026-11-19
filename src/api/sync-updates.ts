import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { findActiveSession } from "../db/sessions";
import type { Platform } from "../platform";
import { getSessionCookie } from "./auth";
import { defaultHook } from "./hook";
import { ErrorSchema, errorBody } from "./schemas";

const errorContent = { "application/json": { schema: ErrorSchema } };

const updatesRoute = createRoute({
  method: "get",
  path: "/sync/updates",
  summary: "受信箱の更新を WebSocket で受け取る",
  description:
    '同じオリジンからセッションのクッキーで接続する。受信箱が変わると {"type":"sync_required"} が届くので、最後のカーソルから差分を取る。再接続時にも差分を取る。',
  security: [{ sessionCookie: [] }],
  responses: {
    101: { description: "WebSocket 接続を開始した" },
    400: { description: "WebSocket への切り替えが必要", content: errorContent },
    401: { description: "有効なブラウザのセッションが必要", content: errorContent },
    403: { description: "ほかのオリジンからは接続できない", content: errorContent },
    429: { description: "WebSocket の接続数の上限に達した", content: errorContent },
    503: { description: "サーバーは終了処理中", content: errorContent },
  },
});

export function syncUpdatesApi(platform: Platform) {
  return new OpenAPIHono({ defaultHook }).openapi(updatesRoute, async (c) => {
    if (c.req.header("origin") !== new URL(c.req.url).origin) {
      return c.json(errorBody("forbidden", "same-origin WebSocket required"), 403);
    }
    const token = getSessionCookie(c);
    const session = token && (await findActiveSession(platform.db, { token, now: platform.now() }));
    if (!session) {
      return c.json(errorBody("unauthorized", "a valid browser session is required"), 401);
    }
    if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
      return c.json(errorBody("invalid_request", "WebSocket upgrade required"), 400);
    }
    return platform.syncUpdates.connect(c, session);
  });
}
