import type { MiddlewareHandler } from "hono";
import type { User } from "../db/schema";
import { authenticateToken } from "../db/tokens";
import type { Platform } from "../platform";
import { errorBody } from "./schemas";

/** 認証したリクエストに付く情報。ハンドラーでは c.get("user") で読む */
export type AuthVariables = { user: User };

/**
 * Authorization: Bearer <アクセストークン> で認証する（docs/decisions/accounts.md）。
 * トークンの持ち主のユーザーを c.set("user") に置く。
 */
export function tokenAuth(
  platform: Pick<Platform, "db" | "now">,
): MiddlewareHandler<{ Variables: AuthVariables }> {
  return async (c, next) => {
    const match = /^Bearer\s+(\S+)\s*$/i.exec(c.req.header("authorization") ?? "");
    const token = match?.[1];
    const auth =
      token === undefined
        ? undefined
        : await authenticateToken(platform.db, { token, now: platform.now() });
    if (!auth) {
      return c.json(errorBody("unauthorized", "a valid access token is required"), 401, {
        "www-authenticate": 'Bearer realm="sendo"',
      });
    }
    c.set("user", auth.user);
    return next();
  };
}
