import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { getVapidPublicKey } from "../notify/vapid";
import type { Platform } from "../platform";
import type { AuthVariables } from "./auth";
import { defaultHook } from "./hook";
import { ErrorSchema, errorBody } from "./schemas";

/*
 * Web Push の有無と VAPID の公開鍵（docs/decisions/notifications.md の 19）。
 *
 * ブラウザのセッションでだけ使える。登録は端末（セッション）に結ぶもので、アクセストークンは端末に
 * 結び付かない（同じく 20）。
 */

const error = (description: string) => ({
  description,
  content: { "application/json": { schema: ErrorSchema } },
});

const security = [{ sessionCookie: [] as string[] }];
const sessionRequired = error("ブラウザのセッションではない（アクセストークンでは使えない）");

const PushStatusSchema = z
  .object({
    available: z.boolean().openapi({
      description: "Web Push を使える設定（VAPID_SUBJECT と READER_URL）がそろっているか",
    }),
    publicKey: z.string().nullable().openapi({
      description:
        "VAPID の公開鍵（P-256 の非圧縮の点 65 バイトの base64url）。PushManager.subscribe の applicationServerKey に渡す。手元の登録の鍵と違えば、登録し直す。使えなければ null",
    }),
  })
  .openapi("PushStatus");

const statusRoute = createRoute({
  method: "get",
  path: "/push",
  summary: "Web Push の有無と VAPID の公開鍵",
  security,
  responses: {
    200: {
      description: "有無と公開鍵",
      content: { "application/json": { schema: PushStatusSchema } },
    },
    403: sessionRequired,
  },
});

/** セッションで認証していなければ 403 の応答 */
function denySession(c: Context) {
  return c.json(
    errorBody("session_required", "sign in with a browser session to use push notifications"),
    403,
  );
}

export function pushApi(platform: Platform) {
  const { db } = platform;
  return new OpenAPIHono<{ Variables: AuthVariables }>({ defaultHook }).openapi(
    statusRoute,
    async (c) => {
      if (c.get("auth").kind !== "session") return denySession(c);
      if (!platform.push) return c.json({ available: false, publicKey: null }, 200);
      return c.json({ available: true, publicKey: await getVapidPublicKey(db) }, 200);
    },
  );
}
