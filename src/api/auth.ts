import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { User } from "../db/schema";
import { authenticateSession, SESSION_TTL_MS } from "../db/sessions";
import { authenticateToken } from "../db/tokens";
import type { Platform } from "../platform";
import { errorBody } from "./schemas";

/** どの方法で認証したか */
export type AuthMethod =
  | { kind: "token"; tokenId: string }
  | { kind: "session"; sessionId: string };

/** 認証したリクエストに付く情報。ハンドラーでは c.get("user") で読む */
export type AuthVariables = { user: User; auth: AuthMethod };

/**
 * セッションのクッキーの名前（実際には __Host- が付く）。__Host- を付けると、Secure で、Path=/ で、
 * Domain なしのクッキーしか置けないので、サブドメインなどほかの場所から上書きされない。
 */
export const SESSION_COOKIE = "sendo_session";

/** セッションのクッキーを置く。HttpOnly でページの JS から読めないようにする（docs/decisions/accounts.md の 6） */
export function setSessionCookie(c: Context, token: string): void {
  setCookie(c, SESSION_COOKIE, token, {
    prefix: "host",
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export function deleteSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, { prefix: "host", path: "/", secure: true });
}

export function getSessionCookie(c: Context): string | undefined {
  return getCookie(c, SESSION_COOKIE, "host");
}

/** 状態を変えないメソッド。クッキーで認証しても、ほかのサイトから送られて困ることはない */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * 同じオリジンのページから送られたリクエストか（CSRF 対策）。
 *
 * SameSite=Lax のクッキーは、ほかのサイトからの POST には付かないが、同じサイト（サブドメイン）
 * からは付く。そこで、クッキーで認証して状態を変えるリクエストは、ブラウザが付ける Sec-Fetch-Site が
 * same-origin のものだけを受ける。付けないブラウザでは、Origin が同じかで見る。
 */
export function isSameOriginRequest(c: Context): boolean {
  const site = c.req.header("sec-fetch-site");
  if (site !== undefined) return site === "same-origin";
  const origin = c.req.header("origin");
  return origin !== undefined && origin === new URL(c.req.url).origin;
}

function unauthorized(c: Context) {
  return c.json(errorBody("unauthorized", "a valid access token or session is required"), 401, {
    "www-authenticate": 'Bearer realm="sendo"',
  });
}

/**
 * 次のどちらかで認証する（docs/decisions/accounts.md の 6）。認証したユーザーを c.set("user") に置く。
 *
 * - Authorization: Bearer <アクセストークン>：エージェントやスクリプト、リーダーアプリ
 * - セッションのクッキー：ブラウザ（sendo-reader）。状態を変えるリクエストは、同じオリジンからだけ
 *
 * Authorization を付けたら、クッキーは見ない（トークンが正しくなければ 401）。
 */
export function authenticate(
  platform: Pick<Platform, "db" | "now">,
): MiddlewareHandler<{ Variables: AuthVariables }> {
  return async (c, next) => {
    const header = c.req.header("authorization");
    if (header !== undefined) {
      const token = /^Bearer\s+(\S+)\s*$/i.exec(header)?.[1];
      const auth =
        token === undefined
          ? undefined
          : await authenticateToken(platform.db, { token, now: platform.now(), purpose: "reader" });
      if (!auth) return unauthorized(c);
      c.set("user", auth.user);
      c.set("auth", { kind: "token", tokenId: auth.tokenId });
      return next();
    }

    const cookie = getSessionCookie(c);
    if (cookie === undefined) return unauthorized(c);
    if (!SAFE_METHODS.has(c.req.method) && !isSameOriginRequest(c)) {
      return c.json(errorBody("forbidden", "cross-site requests are not allowed"), 403);
    }
    const auth = await authenticateSession(platform.db, { token: cookie, now: platform.now() });
    if (!auth) {
      deleteSessionCookie(c);
      return unauthorized(c);
    }
    // 期限を延ばしたら、クッキーの期限も延ばす
    if (auth.renewed) setSessionCookie(c, cookie);
    c.set("user", auth.user);
    c.set("auth", { kind: "session", sessionId: auth.session.id });
    return next();
  };
}
