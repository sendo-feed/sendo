import { and, desc, eq, exists, gt, isNull, lte, max, not, type SQL, sql } from "drizzle-orm";
import { randomBase64Url } from "../lib/crypto";
import type { Database } from ".";
import {
  type OAuthCode,
  type OAuthGrant,
  type OAuthRegisteredClient,
  type OAuthToken,
  oauthClients,
  oauthCodes,
  oauthGrants,
  oauthTokens,
  type User,
  users,
} from "./schema";
import { formatScopes, hashToken, type McpScope } from "./tokens";

/*
 * OAuth の認可サーバーが持つもの（docs/decisions/mcp.md の 5、7）。
 *
 * - クライアント（動的登録したものだけ。Client ID Metadata Document のものは置かない）
 * - 許可：利用者が許可の画面で「許可」を選ぶたびに 1 つ。認可コードとトークンはこれに付く
 * - 認可コード（5 分、1 回だけ）、アクセストークン（1 時間）、リフレッシュトークン（30 日、使うたびに作り直す）
 *
 * コードもトークンも、DB にはハッシュだけを置く。
 */

/** OAuth のアクセストークンの先頭。MCP 用のトークン（sendo_ と乱数）と見分ける */
export const OAUTH_ACCESS_TOKEN_PREFIX = "sendo_at_";
/** OAuth のリフレッシュトークンの先頭 */
export const OAUTH_REFRESH_TOKEN_PREFIX = "sendo_rt_";

/** 認可コードの期限（OAuth 2.1 は 10 分以内を勧める） */
export const CODE_TTL_MS = 5 * 60 * 1000;
/** アクセストークンの期限（決定の 7） */
export const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
/** リフレッシュトークンの期限。作り直すたびに、そこから 30 日 */
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * 作ったばかりの許可を「使える」とみなす時間。認可コードの期限に、コードを換える処理の途中で
 * 期限をまたいでも掃除で消されないよう、余裕を足す
 */
const NEW_GRANT_MS = CODE_TTL_MS + 60 * 1000;
/** 動的登録したまま、一度も許可されていないクライアントを残す時間 */
const UNUSED_CLIENT_TTL_MS = 24 * 60 * 60 * 1000;

/** コードとトークンの乱数の部分の長さ（バイト） */
const SECRET_BYTES = 32;

/**
 * クライアントを登録する（動的登録）。誰でも登録できるので、一度も許可されないまま 1 日たった
 * クライアントは、ここで消す（溜まり続けないように）。一度許可されたものは、許可がなくなっても残す
 */
export async function registerClient(
  db: Database,
  input: { name: string | null; redirectUris: readonly string[]; now: Date },
): Promise<OAuthRegisteredClient> {
  await db
    .delete(oauthClients)
    .where(
      and(
        isNull(oauthClients.authorizedAt),
        lte(oauthClients.createdAt, new Date(input.now.getTime() - UNUSED_CLIENT_TTL_MS)),
      ),
    )
    .run();
  return db
    .insert(oauthClients)
    .values({
      id: crypto.randomUUID(),
      name: input.name,
      redirectUris: [...input.redirectUris],
      createdAt: input.now,
    })
    .returning()
    .get();
}

export async function getRegisteredClient(
  db: Database,
  id: string,
): Promise<OAuthRegisteredClient | undefined> {
  return db.select().from(oauthClients).where(eq(oauthClients.id, id)).get();
}

/**
 * まだ使える許可の条件。作ったばかり（認可コードを使う前か、使っている途中）か、期限の切れていない
 * リフレッシュトークン（作り直す前のもの）があるもの。リフレッシュトークンを作り直すときは、新しい
 * ものを入れてから古いものに印を付けるので、その途中でもこの条件を満たす（oauth/token.ts）
 */
function activeGrant(db: Database, now: Date): SQL {
  const live = exists(
    db
      .select({ one: sql`1` })
      .from(oauthTokens)
      .where(
        and(
          eq(oauthTokens.grantId, oauthGrants.id),
          eq(oauthTokens.kind, "refresh"),
          isNull(oauthTokens.rotatedAt),
          gt(oauthTokens.expiresAt, now),
        ),
      ),
  );
  return sql`(${gt(oauthGrants.createdAt, new Date(now.getTime() - NEW_GRANT_MS))} or ${live})`;
}

/**
 * 許可を作り、認可コードを出す。その人の、もう使えない許可は先に消す
 * （コードやトークンも一緒に消える）。
 */
export async function createGrant(
  db: Database,
  input: {
    userId: string;
    clientId: string;
    clientName: string | null;
    scopes: readonly McpScope[];
    resource: string;
    redirectUri: string;
    codeChallenge: string;
    now: Date;
  },
): Promise<{ grant: OAuthGrant; code: string }> {
  await db
    .delete(oauthGrants)
    .where(and(eq(oauthGrants.userId, input.userId), not(activeGrant(db, input.now))))
    .run();
  const grant = await db
    .insert(oauthGrants)
    .values({
      id: crypto.randomUUID(),
      userId: input.userId,
      clientId: input.clientId,
      clientName: input.clientName,
      scopes: formatScopes(input.scopes),
      resource: input.resource,
      createdAt: input.now,
    })
    .returning()
    .get();
  // 動的登録のクライアントなら、許可された印を付ける（Client ID Metadata Document のものは行がない）
  await db
    .update(oauthClients)
    .set({ authorizedAt: input.now })
    .where(and(eq(oauthClients.id, input.clientId), isNull(oauthClients.authorizedAt)))
    .run();
  const code = randomBase64Url(SECRET_BYTES);
  await db
    .insert(oauthCodes)
    .values({
      codeHash: await hashToken(code),
      grantId: grant.id,
      redirectUri: input.redirectUri,
      codeChallenge: input.codeChallenge,
      expiresAt: new Date(input.now.getTime() + CODE_TTL_MS),
    })
    .run();
  return { grant, code };
}

/** 許可を取り消す。コードとトークンも消え、すぐに使えなくなる */
export async function revokeGrant(db: Database, grantId: string): Promise<void> {
  await db.delete(oauthGrants).where(eq(oauthGrants.id, grantId)).run();
}

export type RedeemCodeResult =
  | { status: "ok"; code: OAuthCode; grant: OAuthGrant }
  | { status: "invalid" }
  /** 使ったコードがもう一度来た。許可は取り消した */
  | { status: "reused" };

/**
 * 認可コードを使った印を付け、そのコードと許可を返す。印は同じ文の中で、まだ使っていない
 * ときだけ付ける（同時に 2 回来ても、片方しか通らない）。
 *
 * 使ったコードがもう一度来たら、コードが漏れたとみなし、許可ごと取り消す（OAuth 2.1 の 4.1.3）。
 * 期限やクライアントなどの確認は、呼ぶ側（oauth/token.ts）が行う。
 */
export async function redeemCode(
  db: Database,
  input: { code: string; now: Date },
): Promise<RedeemCodeResult> {
  const codeHash = await hashToken(input.code);
  const used = await db
    .update(oauthCodes)
    .set({ usedAt: input.now })
    .where(and(eq(oauthCodes.codeHash, codeHash), isNull(oauthCodes.usedAt)))
    .returning()
    .get();
  if (!used) {
    const existing = await db
      .select({ grantId: oauthCodes.grantId })
      .from(oauthCodes)
      .where(eq(oauthCodes.codeHash, codeHash))
      .get();
    if (!existing) return { status: "invalid" };
    await revokeGrant(db, existing.grantId);
    return { status: "reused" };
  }
  const grant = await db.select().from(oauthGrants).where(eq(oauthGrants.id, used.grantId)).get();
  return grant ? { status: "ok", code: used, grant } : { status: "invalid" };
}

/** リフレッシュトークンと、その許可を引く。ないか、形が違えば undefined */
export async function findRefreshToken(
  db: Database,
  token: string,
): Promise<{ token: OAuthToken; grant: OAuthGrant } | undefined> {
  if (!token.startsWith(OAUTH_REFRESH_TOKEN_PREFIX)) return undefined;
  return db
    .select({ token: oauthTokens, grant: oauthGrants })
    .from(oauthTokens)
    .innerJoin(oauthGrants, eq(oauthTokens.grantId, oauthGrants.id))
    .where(and(eq(oauthTokens.tokenHash, await hashToken(token)), eq(oauthTokens.kind, "refresh")))
    .get();
}

/**
 * リフレッシュトークンに、作り直した印を付ける。まだ付いていないときだけ付ける（同じ文の中で
 * 確かめる）。付けられなければ false（同時にもう一方が使った）
 */
export async function markRefreshTokenRotated(
  db: Database,
  input: { id: string; now: Date },
): Promise<boolean> {
  const rotated = await db
    .update(oauthTokens)
    .set({ rotatedAt: input.now })
    .where(and(eq(oauthTokens.id, input.id), isNull(oauthTokens.rotatedAt)))
    .returning({ id: oauthTokens.id })
    .get();
  return rotated !== undefined;
}

export type IssuedTokens = {
  accessToken: string;
  refreshToken: string;
  /** アクセストークンの期限までの秒数 */
  expiresIn: number;
};

/**
 * 許可に、新しいアクセストークンとリフレッシュトークンを出す。その許可の、期限の切れた
 * トークン（作り直したあとのリフレッシュトークンを含む）は、ここで消す
 */
export async function issueTokens(
  db: Database,
  input: {
    grantId: string;
    /** アクセストークンの範囲。許可の範囲より狭くてもよい */
    accessScopes: readonly McpScope[];
    /** リフレッシュトークンの範囲（許可の範囲） */
    refreshScopes: readonly McpScope[];
    now: Date;
  },
): Promise<IssuedTokens> {
  const now = input.now.getTime();
  const accessToken = OAUTH_ACCESS_TOKEN_PREFIX + randomBase64Url(SECRET_BYTES);
  const refreshToken = OAUTH_REFRESH_TOKEN_PREFIX + randomBase64Url(SECRET_BYTES);
  await db
    .insert(oauthTokens)
    .values([
      {
        id: crypto.randomUUID(),
        grantId: input.grantId,
        kind: "access",
        tokenHash: await hashToken(accessToken),
        scopes: formatScopes(input.accessScopes),
        createdAt: input.now,
        expiresAt: new Date(now + ACCESS_TOKEN_TTL_MS),
      },
      {
        id: crypto.randomUUID(),
        grantId: input.grantId,
        kind: "refresh",
        tokenHash: await hashToken(refreshToken),
        scopes: formatScopes(input.refreshScopes),
        createdAt: input.now,
        expiresAt: new Date(now + REFRESH_TOKEN_TTL_MS),
      },
    ])
    .run();
  await db
    .delete(oauthTokens)
    .where(and(eq(oauthTokens.grantId, input.grantId), lte(oauthTokens.expiresAt, input.now)))
    .run();
  return { accessToken, refreshToken, expiresIn: ACCESS_TOKEN_TTL_MS / 1000 };
}

/**
 * OAuth のアクセストークンから、その持ち主と許可を引く。ない ／ 期限が切れていれば undefined。
 * 宛先（resource）の確認は、呼ぶ側（mcp/index.ts）が行う
 */
export async function authenticateOAuthAccessToken(
  db: Database,
  input: { token: string; now: Date },
): Promise<{ user: User; grant: OAuthGrant; token: OAuthToken } | undefined> {
  if (!input.token.startsWith(OAUTH_ACCESS_TOKEN_PREFIX)) return undefined;
  return db
    .select({ user: users, grant: oauthGrants, token: oauthTokens })
    .from(oauthTokens)
    .innerJoin(oauthGrants, eq(oauthTokens.grantId, oauthGrants.id))
    .innerJoin(users, eq(oauthGrants.userId, users.id))
    .where(
      and(
        eq(oauthTokens.tokenHash, await hashToken(input.token)),
        eq(oauthTokens.kind, "access"),
        gt(oauthTokens.expiresAt, input.now),
      ),
    )
    .get();
}

/** 一覧に出す許可。最後に使った時刻は、最後にトークンを出した時刻（使っていなければ null） */
export type GrantWithUsage = OAuthGrant & { lastUsedAt: Date | null };

/** その人の、まだ使える許可（新しい順） */
export async function listGrants(
  db: Database,
  input: { userId: string; now: Date },
): Promise<GrantWithUsage[]> {
  // sql のテンプレートに直接書いた列には表の名前が付かないので、サブクエリはクエリビルダーで組む
  // （where の列に表の名前が付き、外側の oauth_grants を正しく指す）
  const lastUsedAt = db
    .select({ at: max(oauthTokens.createdAt) })
    .from(oauthTokens)
    .where(eq(oauthTokens.grantId, oauthGrants.id));
  const rows = await db
    .select({ grant: oauthGrants, lastUsedAt: sql<number | null>`(${lastUsedAt})` })
    .from(oauthGrants)
    .where(and(eq(oauthGrants.userId, input.userId), activeGrant(db, input.now)))
    .orderBy(desc(oauthGrants.createdAt), desc(oauthGrants.id))
    .all();
  return rows.map(({ grant, lastUsedAt }) => ({
    ...grant,
    lastUsedAt: lastUsedAt === null ? null : new Date(lastUsedAt),
  }));
}

/**
 * 許可を取り消す。その人のものだけを消す。
 * @returns 消したか。その人の許可になければ false
 */
export async function deleteGrant(
  db: Database,
  input: { userId: string; id: string },
): Promise<boolean> {
  const deleted = await db
    .delete(oauthGrants)
    .where(and(eq(oauthGrants.id, input.id), eq(oauthGrants.userId, input.userId)))
    .returning({ id: oauthGrants.id })
    .get();
  return deleted !== undefined;
}
