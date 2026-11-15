import {
  findRefreshToken,
  type IssuedTokens,
  issueTokens,
  markRefreshTokenRotated,
  redeemCode,
  revokeGrant,
} from "../db/oauth";
import type { OAuthGrant } from "../db/schema";
import { formatScopes, type McpScope, parseScopes } from "../db/tokens";
import { base64UrlEncode, sha256 } from "../lib/crypto";
import type { OAuthServerConfig, Platform } from "../platform";
import { isMcpResource, mcpResource } from "./authorize";

/*
 * トークンのエンドポイント（OAuth 2.1 の 3.2）の中身（docs/decisions/mcp.md の 3、7）。
 *
 * - authorization_code：認可コードを、アクセストークン（1 時間）とリフレッシュトークン（30 日）に換える。
 *   PKCE（S256）、redirect_uri、client_id、宛先（resource）を確かめる
 * - refresh_token：リフレッシュトークンを作り直し、新しいアクセストークンを出す。作り直した古い
 *   リフレッシュトークンがもう一度来たら、漏れたとみなして許可ごと取り消す
 *
 * クライアントはどれも公開クライアントなので、クライアントの認証はない（client_id だけを見る）。
 */

export type TokenErrorCode =
  | "invalid_request"
  | "invalid_grant"
  | "unsupported_grant_type"
  | "invalid_scope"
  | "invalid_target";

/** トークンのリクエストの誤り。400 と、OAuth の誤りの JSON で返す */
export class TokenError extends Error {
  override readonly name = "TokenError";
  constructor(
    readonly code: TokenErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** トークンの応答（OAuth 2.1 の 3.2.3） */
export type TokenResponse = {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
};

function toResponse(tokens: IssuedTokens, scopes: readonly McpScope[]): TokenResponse {
  return {
    access_token: tokens.accessToken,
    token_type: "Bearer",
    expires_in: tokens.expiresIn,
    refresh_token: tokens.refreshToken,
    scope: formatScopes(scopes),
  };
}

/** PKCE の code_verifier が、code_challenge（S256）に合うか（RFC 7636 の 4.6） */
async function verifyPkce(verifier: string, challenge: string): Promise<boolean> {
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) return false;
  return base64UrlEncode(await sha256(verifier)) === challenge;
}

/**
 * 許可の宛先が、この MCP サーバーかを確かめる（設定の PUBLIC_URL を変えたら、前の許可は使えない）。
 * resource を付けていれば、それも同じかを確かめる
 */
function checkResource(config: OAuthServerConfig, params: URLSearchParams, grant: OAuthGrant) {
  if (grant.resource !== mcpResource(config)) {
    throw new TokenError("invalid_grant", "the authorization is for another resource");
  }
  const resource = params.get("resource");
  if (resource !== null && !isMcpResource(config, resource)) {
    throw new TokenError("invalid_target", "resource does not match the authorization");
  }
}

function required(params: URLSearchParams, name: string): string {
  const value = params.get(name);
  if (value === null || value === "")
    throw new TokenError("invalid_request", `${name} is required`);
  return value;
}

/**
 * トークンのリクエストを処理する。誤りは TokenError で投げる。
 * @param clientId 本文の client_id か、Authorization: Basic のユーザー名
 */
export async function handleTokenRequest(
  platform: Pick<Platform, "db" | "now">,
  config: OAuthServerConfig,
  params: URLSearchParams,
  clientId: string | undefined,
): Promise<TokenResponse> {
  if (clientId === undefined || clientId === "") {
    throw new TokenError("invalid_request", "client_id is required");
  }
  const grantType = params.get("grant_type");
  if (grantType === "authorization_code") {
    return exchangeCode(platform, config, params, clientId);
  }
  if (grantType === "refresh_token") return refresh(platform, config, params, clientId);
  throw new TokenError(
    "unsupported_grant_type",
    "grant_type must be authorization_code or refresh_token",
  );
}

async function exchangeCode(
  platform: Pick<Platform, "db" | "now">,
  config: OAuthServerConfig,
  params: URLSearchParams,
  clientId: string,
): Promise<TokenResponse> {
  const code = required(params, "code");
  const redirectUri = required(params, "redirect_uri");
  const codeVerifier = required(params, "code_verifier");
  const now = platform.now();

  // 先に使った印を付ける（確かめるのに失敗しても、そのコードはもう使えない）
  const redeemed = await redeemCode(platform.db, { code, now });
  if (redeemed.status === "reused") {
    throw new TokenError("invalid_grant", "authorization code was already used");
  }
  if (redeemed.status === "invalid")
    throw new TokenError("invalid_grant", "invalid authorization code");
  const { grant } = redeemed;
  if (redeemed.code.expiresAt.getTime() <= now.getTime()) {
    throw new TokenError("invalid_grant", "authorization code has expired");
  }
  if (grant.clientId !== clientId) {
    throw new TokenError("invalid_grant", "authorization code was issued to another client");
  }
  if (redeemed.code.redirectUri !== redirectUri) {
    throw new TokenError("invalid_grant", "redirect_uri does not match the authorization request");
  }
  if (!(await verifyPkce(codeVerifier, redeemed.code.codeChallenge))) {
    throw new TokenError("invalid_grant", "code_verifier does not match the code_challenge");
  }
  checkResource(config, params, grant);

  const scopes = parseScopes(grant.scopes);
  const tokens = await issueTokens(platform.db, {
    grantId: grant.id,
    accessScopes: scopes,
    refreshScopes: scopes,
    now,
  });
  return toResponse(tokens, scopes);
}

async function refresh(
  platform: Pick<Platform, "db" | "now">,
  config: OAuthServerConfig,
  params: URLSearchParams,
  clientId: string,
): Promise<TokenResponse> {
  const token = required(params, "refresh_token");
  const now = platform.now();

  const found = await findRefreshToken(platform.db, token);
  if (!found) throw new TokenError("invalid_grant", "invalid refresh token");
  const { grant } = found;
  if (found.token.rotatedAt !== null) {
    // 作り直した古いトークンが来た。クライアントか攻撃者のどちらかが、漏れたものを使っている
    await revokeGrant(platform.db, grant.id);
    throw new TokenError("invalid_grant", "refresh token was already used");
  }
  if (found.token.expiresAt.getTime() <= now.getTime()) {
    throw new TokenError("invalid_grant", "refresh token has expired");
  }
  if (grant.clientId !== clientId) {
    throw new TokenError("invalid_grant", "refresh token was issued to another client");
  }
  checkResource(config, params, grant);

  // 範囲を付けていれば、許可の範囲の中で狭められる（RFC 6749 の 6）。認可のときと同じく、
  // 知らない範囲（offline_access など）は無視する
  const granted = parseScopes(found.token.scopes);
  const requested = (params.get("scope") ?? "")
    .split(" ")
    .filter((scope): scope is McpScope => scope === "read" || scope === "write");
  if (requested.some((scope) => !granted.includes(scope))) {
    throw new TokenError("invalid_scope", "scope exceeds the authorization");
  }
  const accessScopes = requested.length > 0 ? parseScopes(formatScopes(requested)) : granted;

  // 新しいトークンを先に入れ、そのあとで古いものに作り直した印を付ける。逆の順だと、その間は
  // 作り直していないリフレッシュトークンがなくなり、同じ人がほかの許可を出したときの掃除で、
  // この許可が「もう使えない」とみなされて消される（db/oauth.ts の activeGrant）
  const tokens = await issueTokens(platform.db, {
    grantId: grant.id,
    accessScopes,
    refreshScopes: granted,
    now,
  });
  if (!(await markRefreshTokenRotated(platform.db, { id: found.token.id, now }))) {
    // 同時にもう一方が使った。どちらかが漏れたものなので、許可ごと取り消す（いま出したトークンも消える）
    await revokeGrant(platform.db, grant.id);
    throw new TokenError("invalid_grant", "refresh token was already used");
  }
  return toResponse(tokens, accessScopes);
}
