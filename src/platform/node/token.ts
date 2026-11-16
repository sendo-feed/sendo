/**
 * コンテナ版で、アクセストークンを発行する（Cloudflare 版の scripts/create-token.mjs に当たる）。
 * ブラウザでログインせずに使い始めるときに、コンテナの中で動かす。
 *
 *   docker compose exec sendo node dist/node/sendo.mjs token:create --email you@example.com
 */
import { eq } from "drizzle-orm";
import type { Database } from "../../db";
import { users } from "../../db/schema";
import { createAccessToken, type McpScope, normalizeTokenName } from "../../db/tokens";

const EMAIL_PATTERN = /^[^\s@'"\\]+@[^\s@'"\\]+\.[^\s@'"\\]+$/;

export interface TokenRequest {
  email: string;
  name: string;
  /** MCP 用（/mcp でだけ使える）にする */
  mcp: boolean;
  /** MCP 用のトークンに、状態を変えるツールも許す */
  write: boolean;
}

/** 入力を確かめる。正しくなければ、理由を投げる */
export function normalizeTokenRequest(input: TokenRequest): TokenRequest {
  const email = input.email.trim().toLowerCase();
  if (!EMAIL_PATTERN.test(email)) throw new Error(`メールアドレスの形が正しくない: ${input.email}`);
  const name = normalizeTokenName(input.name);
  if (name === null) throw new Error("--name は 1〜100 文字で指定する");
  if (input.write && !input.mcp) throw new Error("--write は --mcp と一緒に使う");
  return { ...input, email, name };
}

/** メールのユーザーにトークンを発行する。ユーザーがいなければ作る。トークンの中身を返す */
export async function createTokenForEmail(
  db: Database,
  request: TokenRequest,
  now: Date,
): Promise<string> {
  const input = normalizeTokenRequest(request);
  await db
    .insert(users)
    .values({ id: crypto.randomUUID(), email: input.email, createdAt: now })
    .onConflictDoNothing({ target: users.email })
    .run();
  const user = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, input.email))
    .get();
  if (user === undefined) throw new Error(`ユーザーを作れなかった: ${input.email}`);
  const scopes: McpScope[] = input.write ? ["read", "write"] : ["read"];
  const { token } = await createAccessToken(db, {
    userId: user.id,
    name: input.name,
    now,
    purpose: input.mcp ? "mcp" : "reader",
    scopes,
  });
  return token;
}
