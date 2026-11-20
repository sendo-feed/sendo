import type { MiddlewareHandler } from "hono";
import type { User } from "../db/schema";
import { notifySync } from "../lib/sync-notify";
import type { Platform } from "../platform";

/** 状態を変えないメソッド。これ以外のリクエストが成功したら知らせる */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * 利用者の状態を変えるリクエストが成功したら、その利用者の通知の接続に知らせる
 * （docs/decisions/sync.md の 9）。認証のミドルウェアの後ろに 1 つだけ置く。
 *
 * 書き込みごとに知らせると、新しい書き込みを足したときに送り忘れる。入口で知らせれば、
 * 新しい API にも自動でかかる。変わらなかったリクエストでも知らせるが、届いた端末が
 * 空の差分を取るだけで済む。知らせは利用者ごとにまとめて送る（platform/node/sync-updates.ts）
 */
export function notifyChanges(
  platform: Pick<Platform, "syncUpdates">,
): MiddlewareHandler<{ Variables: { user: User } }> {
  return async (c, next) => {
    await next();
    if (SAFE_METHODS.has(c.req.method) || c.res.status < 200 || c.res.status >= 300) return;
    const user = c.get("user");
    if (user !== undefined) await notifySync(platform.syncUpdates.notify, [user.id]);
  };
}
