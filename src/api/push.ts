import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { deletePushRegistration, putPushRegistration } from "../db/push-registrations";
import { MAX_ENDPOINT_LENGTH, parsePushRegistration } from "../notify/registration";
import { getVapidPublicKey } from "../notify/vapid";
import type { Platform } from "../platform";
import type { AuthVariables } from "./auth";
import { defaultHook } from "./hook";
import { ErrorSchema, errorBody } from "./schemas";

/*
 * Web Push の有無と VAPID の公開鍵、端末の登録（docs/decisions/notifications.md の 19、20）。
 *
 * 有無と公開鍵は、アクセストークンでもセッションでも読める。登録の置き外しは、ブラウザのセッションで
 * だけ使える。登録は端末（セッション）に結ぶもので、アクセストークンは端末に結び付かない。状態を変える
 * リクエストは、同じオリジンのページからだけ受ける（auth.ts の CSRF の対策）。エンドポイントと鍵は
 * 秘密として扱い、ログと応答に出さない。
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
  responses: {
    200: {
      description: "有無と公開鍵",
      content: { "application/json": { schema: PushStatusSchema } },
    },
  },
});

// PushSubscription.toJSON() をそのまま送れるよう、知らない項目（expirationTime など）は捨てる
const RegistrationSchema = z
  .object({
    endpoint: z
      .string()
      .max(MAX_ENDPOINT_LENGTH)
      .openapi({
        description: `プッシュサービスの URL（https:、${MAX_ENDPOINT_LENGTH} 文字まで）`,
      }),
    keys: z.object({
      p256dh: z.string().max(256).openapi({
        description: "端末の公開鍵（P-256 の非圧縮の点 65 バイト）の base64url",
      }),
      auth: z.string().max(256).openapi({ description: "認証の秘密（16 バイト）の base64url" }),
    }),
  })
  .openapi("PushRegistration");

const registerRoute = createRoute({
  method: "put",
  path: "/push/registration",
  summary: "この端末の Web Push の登録を置く",
  description:
    "ブラウザが返した登録（PushSubscription.toJSON() の形）を、このセッションに結んで置く。同じ登録を何度送ってもよい。このセッションの前の登録と、ほかのセッションの同じエンドポイントの登録は外れる。ログアウトすると外れる。",
  security,
  request: {
    body: { required: true, content: { "application/json": { schema: RegistrationSchema } } },
  },
  responses: {
    204: { description: "置いた" },
    400: error("エンドポイントか鍵の形が正しくない"),
    403: sessionRequired,
    501: error("Web Push を使う設定（VAPID_SUBJECT と READER_URL）がない"),
  },
});

const unregisterRoute = createRoute({
  method: "delete",
  path: "/push/registration",
  summary: "この端末の Web Push の登録を外す",
  description: "登録がなくても、Web Push を使えない設定でも 204 を返す。",
  security,
  responses: {
    204: { description: "外した、または登録がない" },
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
  return new OpenAPIHono<{ Variables: AuthVariables }>({ defaultHook })
    .openapi(statusRoute, async (c) => {
      if (!platform.push) return c.json({ available: false, publicKey: null }, 200);
      return c.json({ available: true, publicKey: await getVapidPublicKey(db) }, 200);
    })
    .openapi(registerRoute, async (c) => {
      const auth = c.get("auth");
      if (auth.kind !== "session") return denySession(c);
      if (!platform.push) {
        return c.json(errorBody("feature_unavailable", "Web Push is not configured"), 501);
      }
      const registration = await parsePushRegistration(c.req.valid("json"));
      if ("invalid" in registration) {
        return c.json(errorBody("invalid_request", `${registration.invalid}: invalid`), 400);
      }
      await putPushRegistration(db, {
        userId: c.get("user").id,
        sessionId: auth.sessionId,
        now: platform.now(),
        ...registration,
      });
      return c.body(null, 204);
    })
    .openapi(unregisterRoute, async (c) => {
      const auth = c.get("auth");
      if (auth.kind !== "session") return denySession(c);
      await deletePushRegistration(db, { userId: c.get("user").id, sessionId: auth.sessionId });
      return c.body(null, 204);
    });
}
