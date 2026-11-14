import { eq } from "drizzle-orm";
import { randomBase64Url, sha256Hex } from "../lib/crypto";
import type { Database } from ".";
import { type AccessToken, accessTokens, type User, users } from "./schema";

/**
 * トークンの先頭に付ける目印。誤って公開の場所に貼ったときに、シークレットスキャンなどで
 * 見つけやすくし、ログでほかの文字列と見分けられるようにする。
 */
export const TOKEN_PREFIX = "sendo_";

/** トークンの乱数の部分の長さ（バイト） */
const TOKEN_BYTES = 32;

/** 最後に使った時刻を書き直す間隔。毎回書くと、読むだけの API でも DB に書き込みが起きる */
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;

/** 新しいトークン（sendo_ と 32 バイトの乱数を base64url にしたもの） */
export function generateToken(): string {
  return TOKEN_PREFIX + randomBase64Url(TOKEN_BYTES);
}

/**
 * トークンのハッシュ（SHA-256 の 16 進）。DB にはこれだけを置く。
 * ユーザーが決める文字列ではなく 32 バイトの乱数なので、遅いハッシュは要らない。
 * セッションのクッキーの中身も、同じ理由でこれでハッシュにする（db/sessions.ts）。
 */
export function hashToken(token: string): Promise<string> {
  return sha256Hex(token);
}

/** トークンを発行する。中身は戻り値でだけ返し、DB にはハッシュを置く */
export async function createAccessToken(
  db: Database,
  input: { userId: string; name: string; now: Date },
): Promise<{ token: string; record: AccessToken }> {
  const token = generateToken();
  const record = await db
    .insert(accessTokens)
    .values({
      id: crypto.randomUUID(),
      userId: input.userId,
      name: input.name,
      tokenHash: await hashToken(token),
      createdAt: input.now,
    })
    .returning()
    .get();
  return { token, record };
}

/**
 * トークンから、その持ち主のユーザーを引く。なければ undefined。
 * 最後に使った時刻は、1 時間以上たっていれば書き直す。
 */
export async function authenticateToken(
  db: Database,
  input: { token: string; now: Date },
): Promise<{ user: User; tokenId: string } | undefined> {
  if (!input.token.startsWith(TOKEN_PREFIX)) return undefined;
  const row = await db
    .select({ user: users, token: accessTokens })
    .from(accessTokens)
    .innerJoin(users, eq(accessTokens.userId, users.id))
    .where(eq(accessTokens.tokenHash, await hashToken(input.token)))
    .get();
  if (!row) return undefined;

  const lastUsed = row.token.lastUsedAt?.getTime() ?? 0;
  if (input.now.getTime() - lastUsed >= TOUCH_INTERVAL_MS) {
    await db
      .update(accessTokens)
      .set({ lastUsedAt: input.now })
      .where(eq(accessTokens.id, row.token.id))
      .run();
  }
  return { user: row.user, tokenId: row.token.id };
}
