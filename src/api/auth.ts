import type { MiddlewareHandler } from "hono";
import { errorBody } from "./schemas";

/**
 * Authorization: Bearer <トークン> で認証する。
 *
 * トークンが設定されていなければ、すべて拒む（設定し忘れで API が開いたままにならないように）。
 * 比較は SHA-256 のハッシュ同士を最後まで比べ、一致した位置から中身を推測されないようにする。
 */
export function bearerAuth(expected: string | undefined): MiddlewareHandler {
  return async (c, next) => {
    const match = /^Bearer\s+(\S+)\s*$/i.exec(c.req.header("authorization") ?? "");
    const given = match?.[1];
    if (expected === undefined || given === undefined || !(await safeEqual(given, expected))) {
      return c.json(errorBody("unauthorized", "a valid bearer token is required"), 401, {
        "www-authenticate": 'Bearer realm="sendo"',
      });
    }
    return next();
  };
}

async function safeEqual(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [x, y] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  const left = new Uint8Array(x);
  const right = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return diff === 0;
}
