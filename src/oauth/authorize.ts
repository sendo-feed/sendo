import { formatScopes, type McpScope, parseScopes } from "../db/tokens";
import type { OAuthServerConfig, Platform } from "../platform";
import { ClientError, isAllowedRedirectUri, type ResolvedClient, resolveClient } from "./clients";

/*
 * 認可のリクエスト（OAuth 2.1 の 4.1.1）を確かめる（docs/decisions/mcp.md の 3〜6）。
 *
 * 許可の画面（sendo-reader の /oauth/authorize）は、クライアントから受けた URL のクエリを、そのまま
 * Sendo の API（api/oauth.ts）に渡す。Sendo はここで確かめ、許可か拒否の結果をクライアントへ返す
 * リダイレクト先を作る。
 *
 * - client_id と redirect_uri が確かめられないうちの誤りは、クライアントに返さない（ほかの場所へ
 *   リダイレクトさせないため）。画面に出してもらう
 * - そのあとの誤りは、redirect_uri に error と state と iss（RFC 9207）を付けて返す
 */

/** 確かめた認可のリクエスト */
export type AuthorizationRequest = {
  client: ResolvedClient;
  redirectUri: string;
  state: string | undefined;
  /** 求められた範囲。read と write のほかは無視し、なければ read */
  scopes: McpScope[];
  /** トークンの宛先（https://<sendo>/mcp） */
  resource: string;
  codeChallenge: string;
};

/** 認可のリクエストの誤り */
export type AuthorizationError = {
  code: string;
  message: string;
  /** クライアントに返せる誤りなら、error などを付けたリダイレクト先 */
  redirectTo?: string;
};

export type ParseAuthorizationResult =
  | { ok: true; request: AuthorizationRequest }
  | { ok: false; error: AuthorizationError };

/** この Sendo の MCP サーバーの、トークンの宛先（RFC 8707 の resource） */
export function mcpResource(config: OAuthServerConfig): string {
  return `${config.issuer}/mcp`;
}

/**
 * resource の値が、この MCP サーバーを指すか。スキームとホストの大文字・小文字、既定のポート、
 * 末尾の / の違いは許す（MCP の仕様の「Canonical Server URI」）。クエリとフラグメントは受けない
 */
export function isMcpResource(config: OAuthServerConfig, value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.search !== "" || url.hash !== "" || value.includes("#") || value.includes("?")) {
    return false;
  }
  return `${url.origin}${url.pathname.replace(/\/$/, "")}` === mcpResource(config);
}

/** 求められた範囲を読む。知らない範囲は無視し、何もなければ read。write があれば read も付ける */
export function parseRequestedScopes(value: string | null | undefined): McpScope[] {
  const known = (value ?? "")
    .split(" ")
    .filter((scope): scope is McpScope => scope === "read" || scope === "write");
  return parseScopes(formatScopes(known.length > 0 ? known : ["read"]));
}

/**
 * 認可の応答のリダイレクト先を作る。redirect_uri（登録されたもの）に、値と iss を付ける。
 * redirect_uri にもとからあるクエリは、そのまま残す
 */
export function authorizationResponseUrl(
  redirectUri: string,
  config: OAuthServerConfig,
  params: Record<string, string | undefined>,
): string {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined) query.append(name, value);
  }
  query.append("iss", config.issuer);
  const separator = !redirectUri.includes("?")
    ? "?"
    : redirectUri.endsWith("?") || redirectUri.endsWith("&")
      ? ""
      : "&";
  return `${redirectUri}${separator}${query.toString()}`;
}

/** S256 の code_challenge（SHA-256 を base64url にした 43 文字） */
const CODE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

/**
 * 認可のリクエストのクエリ（?client_id=...）を確かめる。
 * Client ID Metadata Document のクライアントなら、その文書を取りにいく
 */
export async function parseAuthorizationRequest(
  platform: Pick<Platform, "db" | "fetch">,
  config: OAuthServerConfig,
  query: string,
): Promise<ParseAuthorizationResult> {
  const params = new URLSearchParams(query.startsWith("?") ? query.slice(1) : query);
  const reject = (code: string, message: string): ParseAuthorizationResult => ({
    ok: false,
    error: { code, message },
  });

  const clientIds = params.getAll("client_id");
  const clientId = clientIds[0];
  if (clientIds.length !== 1 || clientId === undefined || clientId === "") {
    return reject("invalid_request", "client_id is required exactly once");
  }
  let client: ResolvedClient;
  try {
    client = await resolveClient(platform, clientId);
  } catch (error) {
    if (error instanceof ClientError) return reject("invalid_client", error.message);
    throw error;
  }

  // リダイレクト先は、登録されたものと完全に一致するものだけ（決定の 5）
  const redirectUris = params.getAll("redirect_uri");
  const redirectUri = redirectUris[0];
  if (redirectUris.length !== 1 || redirectUri === undefined) {
    return reject("invalid_request", "redirect_uri is required exactly once");
  }
  if (!client.redirectUris.includes(redirectUri) || !isAllowedRedirectUri(redirectUri)) {
    return reject("invalid_redirect_uri", "redirect_uri is not registered for this client");
  }

  // ここからの誤りは、クライアントに返す
  const state = params.get("state") ?? undefined;
  const fail = (code: string, message: string): ParseAuthorizationResult => ({
    ok: false,
    error: {
      code,
      message,
      redirectTo: authorizationResponseUrl(redirectUri, config, {
        error: code,
        error_description: message,
        state,
      }),
    },
  });

  // 同じ名前の値を 2 つ以上付けてはいけない（OAuth 2.1 の 3.1）
  for (const name of new Set(params.keys())) {
    if (params.getAll(name).length > 1) return fail("invalid_request", `${name} is repeated`);
  }
  if (params.get("response_type") !== "code") {
    return fail("unsupported_response_type", "response_type must be code");
  }
  // PKCE は S256 だけ（決定の 3）
  if (params.get("code_challenge_method") !== "S256") {
    return fail("invalid_request", "code_challenge_method must be S256");
  }
  const codeChallenge = params.get("code_challenge") ?? "";
  if (!CODE_CHALLENGE.test(codeChallenge)) {
    return fail("invalid_request", "code_challenge must be an S256 challenge");
  }
  // トークンの宛先は、この MCP サーバーだけ（RFC 8707）。付けていなければ、この MCP サーバーにする
  const resource = params.get("resource");
  if (resource !== null && !isMcpResource(config, resource)) {
    return fail("invalid_target", "resource must be this MCP server");
  }

  return {
    ok: true,
    request: {
      client,
      redirectUri,
      state,
      scopes: parseRequestedScopes(params.get("scope")),
      resource: mcpResource(config),
      codeChallenge,
    },
  };
}
