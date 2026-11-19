import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { findActiveSession } from "../db/sessions";
import type { Platform } from "../platform";
import { getSessionCookie } from "./auth";
import { defaultHook } from "./hook";

const updatesRoute = createRoute({
  method: "get",
  path: "/sync/updates",
  summary: "受信箱の更新を WebSocket で受け取る",
  description: [
    '同じオリジンからセッションのクッキーで接続する。人ごとの同期の対象が変わると {"type":"sync_required"} が届くので、最後のカーソルから差分を取る。初回の接続時と再接続時にも差分を取る。クライアントからはメッセージを送らない（docs/decisions/sync.md の 9）。',
    "",
    "Sendo は次のコードで接続を閉じる。クライアントは、コードで次の動きを分ける。",
    "- 1001（going away）：Sendo が止まる、または入れ替わる。数秒待ってつなぎ直す",
    "- 1008（session ended）：セッションが切れた。すぐにはつなぎ直さず、同期を 1 回して確かめる。401 ならログインし直し、通れば間を延ばしながらつなぎ直す。クライアントからメッセージが届いたとき（client messages are not supported）も 1008 で閉じる",
    "- 1013（try again later）：接続数の上限に達した。1 分以上空けてつなぎ直す",
    "- そのほか（1006 など）：ネットワークの都合や、応答しない接続を切ったとき。上限を置いて間を延ばしながらつなぎ直す",
    "",
    "101 を返す前に断ったとき（下の 401、403、429、503）は、ブラウザの WebSocket からは状態コードが見えず、1006 で閉じたように見える。ほかの 1006 と同じく、間を延ばしてつなぎ直す。",
  ].join("\n"),
  security: [{ sessionCookie: [] }],
  responses: {
    101: { description: "WebSocket 接続を開始した" },
    400: {
      description:
        "切り替えが必要か、ハンドシェイクの形式が不正。通常の HTTP で受けた場合は本文なし",
      content: { "text/html": { schema: z.string() } },
    },
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
