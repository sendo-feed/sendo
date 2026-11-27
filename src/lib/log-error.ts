import { DrizzleQueryError } from "drizzle-orm";

/**
 * ログに出す前の失敗。drizzle が文の失敗を包む DrizzleQueryError は、メッセージ（と stack）に文へ渡した
 * 値（params）を入れる。端末の Web Push の登録や秘密の鍵がログに出ないよう、文と原因だけの失敗に
 * 置き換える。ほかの失敗はそのまま返す
 */
export function loggableError(error: unknown): unknown {
  if (!(error instanceof DrizzleQueryError)) return error;
  const safe = new Error(`Failed query: ${error.query}`, { cause: error.cause });
  safe.name = "DrizzleQueryError";
  // stack の先頭はメッセージ（params を含む）。呼び出し元の行だけを、もとの stack から引き継ぐ
  const header = `${error.name}: ${error.message}`;
  if (error.stack?.startsWith(header)) {
    safe.stack = `${safe.name}: ${safe.message}${error.stack.slice(header.length)}`;
  }
  return safe;
}
