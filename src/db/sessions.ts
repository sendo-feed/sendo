import { and, eq, gt, lte } from "drizzle-orm";
import { randomBase64Url } from "../lib/crypto";
import type { Database } from ".";
import { type Session, sessions, type User, users } from "./schema";
import { hashToken } from "./tokens";

/*
 * ブラウザのログインのセッション（docs/decisions/accounts.md の 6）。クッキーには乱数を入れ、
 * DB にはそのハッシュだけを置く（アクセストークンと同じ。db/tokens.ts）。
 */

/** 使われないまま、この長さがたったセッションは使えなくなる。使えば、そこから延びる */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** 最後に使った時刻と期限を書き直す間隔。毎回書くと、読むだけの API でも DB に書き込みが起きる */
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;

/** クッキーに入れる乱数の長さ（バイト） */
const SESSION_BYTES = 32;

/**
 * セッションを作る。中身（クッキーに入れる値）は戻り値でだけ返す。
 * あわせて、そのユーザーの期限の切れたセッションを片付ける（ログインのたびに少しずつ）。
 */
export async function createSession(
  db: Database,
  input: { userId: string; now: Date },
): Promise<{ token: string; session: Session }> {
  await db
    .delete(sessions)
    .where(and(eq(sessions.userId, input.userId), lte(sessions.expiresAt, input.now)))
    .run();
  const token = randomBase64Url(SESSION_BYTES);
  const session = await db
    .insert(sessions)
    .values({
      id: crypto.randomUUID(),
      userId: input.userId,
      tokenHash: await hashToken(token),
      createdAt: input.now,
      lastUsedAt: input.now,
      expiresAt: new Date(input.now.getTime() + SESSION_TTL_MS),
    })
    .returning()
    .get();
  return { token, session };
}

/**
 * クッキーの値から、セッションとその持ち主のユーザーを引く。ない ／ 期限が切れていれば undefined。
 * 最後に使ってから 1 時間以上たっていれば、最後に使った時刻と期限を書き直す（renewed が true。
 * クッキーの期限も延ばす）。
 */
export async function authenticateSession(
  db: Database,
  input: { token: string; now: Date },
): Promise<{ user: User; session: Session; renewed: boolean } | undefined> {
  const row = await db
    .select({ user: users, session: sessions })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(eq(sessions.tokenHash, await hashToken(input.token)))
    .get();
  if (!row || row.session.expiresAt.getTime() <= input.now.getTime()) return undefined;

  if (input.now.getTime() - row.session.lastUsedAt.getTime() < TOUCH_INTERVAL_MS) {
    return { ...row, renewed: false };
  }
  const expiresAt = new Date(input.now.getTime() + SESSION_TTL_MS);
  // 期限が切れていないことも同じ文の中で確かめる（読んだあとに消された ／ 切れたものは延ばさない）
  const renewed = await db
    .update(sessions)
    .set({ lastUsedAt: input.now, expiresAt })
    .where(and(eq(sessions.id, row.session.id), gt(sessions.expiresAt, input.now)))
    .returning()
    .get();
  if (!renewed) return undefined;
  return { user: row.user, session: renewed, renewed: true };
}

/** クッキーの値のセッションを消す（ログアウト）。なければ何もしない */
export async function deleteSession(db: Database, token: string): Promise<void> {
  await db
    .delete(sessions)
    .where(eq(sessions.tokenHash, await hashToken(token)))
    .run();
}
