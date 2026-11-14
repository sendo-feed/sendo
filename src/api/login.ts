import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import {
  authorizationUrl,
  createPkce,
  exchangeCode,
  LoginError,
  type LoginErrorCode,
  verifyIdToken,
} from "../auth/oidc";
import { PROVIDERS, type ProviderId } from "../auth/providers";
import { createSession, deleteSession } from "../db/sessions";
import { resolveLoginUser } from "../db/users";
import { base64UrlDecode, base64UrlEncode, randomBase64Url } from "../lib/crypto";
import type { Platform } from "../platform";
import {
  deleteSessionCookie,
  getSessionCookie,
  isSameOriginRequest,
  setSessionCookie,
} from "./auth";
import { defaultHook } from "./hook";
import { ErrorSchema, errorBody } from "./schemas";

/*
 * ブラウザのログイン（docs/decisions/accounts.md の 2、6）。OpenID Connect の認可コードフロー
 * （PKCE 付き）で提供元にログインを頼み、セッションのクッキーを置く。
 *
 * sendo-reader からは、reader Worker の /api の中継を通るので、同じオリジンに見える。
 * 提供元に登録するリダイレクト先は、ブラウザから見た <オリジン>/api/v1/auth/<提供元>/callback。
 */

/**
 * ログインを始めてから戻ってくるまでの値を入れるクッキー（実際には __Host- が付く）。
 * DB に置かず、HttpOnly のクッキーに入れる。始めたブラウザでしかログインを終えられないので、
 * ほかの人が始めたログインを踏ませて、その人のアカウントでログインさせる攻撃（ログイン CSRF）を防ぐ。
 */
const LOGIN_COOKIE = "sendo_login";

/** ログインの画面にいられる時間 */
const LOGIN_TTL_SECONDS = 10 * 60;

/** ログインのクッキーに入れる値 */
const LoginStateSchema = z.object({
  /** 提供元 */
  p: z.string(),
  /** state：戻ってきたリクエストが、このブラウザで始めたものかを確かめる */
  s: z.string(),
  /** nonce：ID トークンが、このログインのために出されたものかを確かめる */
  n: z.string(),
  /** PKCE の code_verifier */
  v: z.string(),
  /** ログインのあとに戻るパス */
  r: z.string(),
});
type LoginState = z.infer<typeof LoginStateSchema>;

function encodeLoginState(state: LoginState): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(state)));
}

function decodeLoginState(value: string | undefined): LoginState | undefined {
  const bytes = value === undefined ? undefined : base64UrlDecode(value);
  if (!bytes) return undefined;
  try {
    const parsed = LoginStateSchema.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * ログインのあとに戻る先。同じオリジンのパスだけを受け、それ以外は "/" にする
 * （ほかのサイトへ飛ばす踏み台にさせない）。
 */
export function safeReturnTo(value: string | undefined): string {
  if (value === undefined || value.length > 1024) return "/";
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return "/";
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return "/";
  }
  const base = "https://sendo.invalid";
  const url = new URL(value, base);
  return url.origin === base ? url.pathname + url.search + url.hash : "/";
}

const ProviderParamSchema = z.object({
  provider: z
    .enum(Object.keys(PROVIDERS) as [ProviderId, ...ProviderId[]])
    .openapi({ param: { name: "provider", in: "path" } }),
});

const error = (description: string) => ({
  description,
  content: { "application/json": { schema: ErrorSchema } },
});

const LOGIN_ERRORS: Record<LoginErrorCode, string> = {
  invalid_request: "始めたブラウザと違う、時間がたったなど",
  access_denied: "提供元の画面でやめた",
  provider_error: "提供元とのやり取りに失敗した",
  invalid_id_token: "提供元の ID トークンが正しくない",
  email_not_verified: "提供元がメールを確認済みとしていない",
  not_allowed: "許可したメールではない",
};

const loginRoute = createRoute({
  method: "get",
  path: "/auth/{provider}/login",
  summary: "提供元でログインする（ブラウザで開く）",
  description:
    "ブラウザをこの URL に移すと、提供元のログインの画面へ送る。ログインできたら、セッションのクッキーを置いて returnTo に戻る。",
  security: [],
  request: {
    params: ProviderParamSchema,
    query: z.object({
      returnTo: z.string().optional().openapi({
        description: "ログインのあとに戻るパス（同じオリジンの / で始まるもの）。既定は /",
        example: "/",
      }),
    }),
  },
  responses: {
    302: { description: "提供元のログインの画面へ" },
    404: error("その提供元のログインを設定していない"),
  },
});

const callbackRoute = createRoute({
  method: "get",
  path: "/auth/{provider}/callback",
  summary: "提供元から戻る先（提供元に登録するリダイレクト先）",
  description: `ログインできたら、セッションのクッキーを置いて、始めたときの returnTo に戻る。できなければ /?login_error=<理由> に戻る。理由：${Object.entries(
    LOGIN_ERRORS,
  )
    .map(([code, text]) => `${code}（${text}）`)
    .join("、")}`,
  security: [],
  request: {
    params: ProviderParamSchema,
    // 長さの上限は、受け取ってログに残すものを抑えるため（提供元の値はどれもこれより短い）
    query: z.object({
      code: z.string().max(2048).optional(),
      state: z.string().max(256).optional(),
      error: z.string().max(256).optional(),
    }),
  },
  responses: { 302: { description: "returnTo か、/?login_error=<理由> へ" } },
});

const logoutRoute = createRoute({
  method: "post",
  path: "/auth/logout",
  summary: "ログアウトする（セッションを消す）",
  description: "セッションがなくても 204 を返す。",
  security: [],
  responses: {
    204: { description: "ログアウトした" },
    403: error("ほかのオリジンから送られた"),
  },
});

export function loginApi(platform: Platform) {
  const { db } = platform;

  const fail = (c: Context, code: LoginErrorCode, detail: string) => {
    // 理由はログに残す。ブラウザには code だけを伝える
    console.warn("login failed", { code, detail });
    return c.redirect(`/?login_error=${code}`, 302);
  };

  return new OpenAPIHono({ defaultHook })
    .openapi(loginRoute, async (c) => {
      const providerId = c.req.valid("param").provider;
      const client = platform.auth[providerId];
      if (!client) {
        return c.json(errorBody("not_found", `login with ${providerId} is not configured`), 404);
      }
      const provider = PROVIDERS[providerId];
      const pkce = await createPkce();
      const state: LoginState = {
        p: providerId,
        s: randomBase64Url(32),
        n: randomBase64Url(32),
        v: pkce.verifier,
        r: safeReturnTo(c.req.valid("query").returnTo),
      };
      setCookie(c, LOGIN_COOKIE, encodeLoginState(state), {
        prefix: "host",
        path: "/",
        secure: true,
        httpOnly: true,
        // 提供元から戻るとき（ほかのサイトからのページの移動）にも付くように Lax にする
        sameSite: "Lax",
        maxAge: LOGIN_TTL_SECONDS,
      });
      const url = authorizationUrl(provider, client, {
        // ブラウザから見たこの URL の隣（.../login → .../callback）。中継の先でも同じオリジンになる
        redirectUri: new URL("callback", c.req.url).href,
        state: state.s,
        nonce: state.n,
        codeChallenge: pkce.challenge,
      });
      return c.redirect(url, 302);
    })
    .openapi(callbackRoute, async (c) => {
      const providerId = c.req.valid("param").provider;
      const query = c.req.valid("query");
      const stored = decodeLoginState(getCookie(c, LOGIN_COOKIE, "host"));
      // 成功しても失敗しても、ログインのクッキーは一度きりで消す
      deleteCookie(c, LOGIN_COOKIE, { prefix: "host", path: "/", secure: true });

      if (query.error !== undefined) {
        const code = query.error === "access_denied" ? "access_denied" : "provider_error";
        return fail(c, code, `provider returned error: ${query.error}`);
      }
      const client = platform.auth[providerId];
      if (!client) return fail(c, "invalid_request", `${providerId} is not configured`);
      if (
        !stored ||
        stored.p !== providerId ||
        query.state === undefined ||
        query.state !== stored.s ||
        query.code === undefined
      ) {
        return fail(c, "invalid_request", "missing or mismatched login state");
      }

      const provider = PROVIDERS[providerId];
      const callbackUrl = new URL(c.req.url);
      callbackUrl.search = "";
      try {
        const idToken = await exchangeCode(platform.fetch, provider, client, {
          code: query.code,
          redirectUri: callbackUrl.href,
          codeVerifier: stored.v,
        });
        const now = platform.now();
        const login = await verifyIdToken(platform.fetch, provider, client, idToken, {
          nonce: stored.n,
          now,
        });
        const user = await resolveLoginUser(db, {
          login,
          isAllowed: (email) => platform.auth.allowedEmails.has(email),
          now,
        });
        if (!user) return fail(c, "not_allowed", "email is not allowed");

        // 前のセッションのクッキーがあれば、その行は消して入れ替える
        const previous = getSessionCookie(c);
        if (previous !== undefined) await deleteSession(db, previous);
        const { token } = await createSession(db, { userId: user.id, now });
        setSessionCookie(c, token);
        // クッキーの値は自分で置いたものだが、念のため戻る先をもう一度確かめる
        return c.redirect(safeReturnTo(stored.r), 302);
      } catch (e) {
        if (e instanceof LoginError) return fail(c, e.code, e.message);
        throw e;
      }
    })
    .openapi(logoutRoute, async (c) => {
      const token = getSessionCookie(c);
      if (token !== undefined) {
        if (!isSameOriginRequest(c)) {
          return c.json(errorBody("forbidden", "cross-site requests are not allowed"), 403);
        }
        await deleteSession(db, token);
        deleteSessionCookie(c);
      }
      return c.body(null, 204);
    });
}
