import { z } from "zod";
import type { VerifiedLogin } from "../db/users";
import { base64UrlDecode, base64UrlEncode, randomBase64Url, sha256 } from "../lib/crypto";
import { readLimited } from "../lib/read-limited";
import type { OAuthClient } from "../platform";
import type { OidcProvider } from "./providers";

/*
 * OpenID Connect の認可コードフロー（PKCE 付き）で、提供元にログインを頼む
 * （docs/decisions/accounts.md の 2）。
 *
 * 1. authorizationUrl：提供元のログインの画面へ送る URL を作る
 * 2. exchangeCode：戻ってきた認可コードを、提供元のトークンのエンドポイントで ID トークンに替える
 * 3. verifyIdToken：ID トークンの署名（提供元の公開鍵）と中身を確かめ、ログインした人を取り出す
 */

/** ログインに失敗した理由。ブラウザには、この code だけを伝える */
export type LoginErrorCode =
  /** state が合わない、ログインのクッキーがないなど。始めたブラウザと違う ／ 時間がたった */
  | "invalid_request"
  /** 提供元の画面で、利用者がやめた */
  | "access_denied"
  /** 提供元がエラーを返した ／ 応答の形が違う ／ つながらない */
  | "provider_error"
  /** ID トークンの署名や中身が正しくない */
  | "invalid_id_token"
  /** 提供元がメールを確認済みとしていない */
  | "email_not_verified"
  /** 許可したメールではない */
  | "not_allowed";

export class LoginError extends Error {
  override readonly name = "LoginError";
  constructor(
    readonly code: LoginErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** 提供元への通信の上限 */
const PROVIDER_TIMEOUT_MS = 10_000;
const PROVIDER_MAX_BYTES = 256 * 1024;

/** 時計のずれを、この分だけ許す */
const CLOCK_SKEW_SECONDS = 60;

/** PKCE（RFC 7636）の code_verifier と、その code_challenge（S256） */
export async function createPkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomBase64Url(32);
  return { verifier, challenge: base64UrlEncode(await sha256(verifier)) };
}

/** 提供元のログインの画面へ送る URL */
export function authorizationUrl(
  provider: OidcProvider,
  client: Pick<OAuthClient, "clientId">,
  input: { redirectUri: string; state: string; nonce: string; codeChallenge: string },
): string {
  const url = new URL(provider.authorizationEndpoint);
  const params: Record<string, string> = {
    client_id: client.clientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    scope: provider.scope,
    state: input.state,
    nonce: input.nonce,
    code_challenge: input.codeChallenge,
    code_challenge_method: "S256",
    ...provider.authorizationParams,
  };
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.href;
}

/** 提供元から JSON を受け取る。失敗はすべて provider_error にする */
async function fetchProviderJson(
  fetcher: typeof fetch,
  url: string,
  init: RequestInit = {},
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetcher(url, {
      ...init,
      headers: { accept: "application/json", ...init.headers },
      redirect: "error",
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
  } catch (error) {
    throw new LoginError("provider_error", `cannot reach ${url}: ${String(error)}`);
  }
  try {
    const body = await readLimited(res.body, res.headers.get("content-length"), PROVIDER_MAX_BYTES);
    const json: unknown = JSON.parse(new TextDecoder().decode(body));
    if (!res.ok) {
      // 提供元のエラーの説明は、利用者の入力を含まないので、ログに残してよい
      throw new LoginError(
        "provider_error",
        `${url} returned ${res.status}: ${JSON.stringify(json)}`,
      );
    }
    return json;
  } catch (error) {
    if (error instanceof LoginError) throw error;
    throw new LoginError("provider_error", `invalid response from ${url}: ${String(error)}`);
  }
}

const TokenResponseSchema = z.object({ id_token: z.string().min(1) });

/**
 * 認可コードを、提供元のトークンのエンドポイントで ID トークンに替える。
 * redirectUri は、認可のリクエストで渡したものと同じにする（提供元が確かめる）。
 */
export async function exchangeCode(
  fetcher: typeof fetch,
  provider: OidcProvider,
  client: OAuthClient,
  input: { code: string; redirectUri: string; codeVerifier: string },
): Promise<string> {
  const json = await fetchProviderJson(fetcher, provider.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: client.clientId,
      client_secret: client.clientSecret,
      code_verifier: input.codeVerifier,
    }),
  });
  const parsed = TokenResponseSchema.safeParse(json);
  if (!parsed.success) throw new LoginError("provider_error", "token response has no id_token");
  return parsed.data.id_token;
}

const JwtHeaderSchema = z.object({ alg: z.string(), kid: z.string().optional() });

const JwksSchema = z.object({
  keys: z.array(
    z.looseObject({ kty: z.string(), kid: z.string().optional(), n: z.string(), e: z.string() }),
  ),
});

const IdTokenClaimsSchema = z.object({
  iss: z.string(),
  sub: z.string().min(1),
  aud: z.union([z.string(), z.array(z.string())]),
  azp: z.string().optional(),
  exp: z.number(),
  iat: z.number(),
  nonce: z.string().optional(),
  email: z.string().optional(),
  email_verified: z.boolean().optional(),
});

/** JWT の 1 つの部分（base64url の JSON）を読む */
function decodeJsonPart(part: string): unknown {
  const bytes = base64UrlDecode(part);
  if (!bytes) throw new LoginError("invalid_id_token", "id token is not base64url");
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new LoginError("invalid_id_token", "id token is not JSON");
  }
}

/** 提供元の公開鍵で、ID トークンの署名（RS256）を確かめる */
async function verifySignature(
  fetcher: typeof fetch,
  provider: OidcProvider,
  token: { header: string; payload: string; signature: string },
): Promise<void> {
  const header = JwtHeaderSchema.safeParse(decodeJsonPart(token.header));
  // 提供元が使う RS256 だけを受ける（none や、公開鍵を HMAC の鍵に使わせる攻撃を防ぐ）
  if (!header.success || header.data.alg !== "RS256" || header.data.kid === undefined) {
    throw new LoginError("invalid_id_token", "id token must be RS256 with kid");
  }
  const jwks = JwksSchema.safeParse(await fetchProviderJson(fetcher, provider.jwksUri));
  if (!jwks.success) throw new LoginError("provider_error", "invalid jwks");
  const jwk = jwks.data.keys.find((key) => key.kid === header.data.kid && key.kty === "RSA");
  if (!jwk) throw new LoginError("invalid_id_token", `unknown key: ${header.data.kid}`);

  const signature = base64UrlDecode(token.signature);
  if (!signature) throw new LoginError("invalid_id_token", "signature is not base64url");
  let valid: boolean;
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: "RSA", n: jwk.n, e: jwk.e },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      signature,
      new TextEncoder().encode(`${token.header}.${token.payload}`),
    );
  } catch (error) {
    throw new LoginError("invalid_id_token", `cannot verify signature: ${String(error)}`);
  }
  if (!valid) throw new LoginError("invalid_id_token", "signature does not match");
}

/**
 * ID トークンの署名と中身を確かめ、ログインした人を取り出す（OpenID Connect Core 3.1.3.7）。
 *
 * - 署名：提供元の公開鍵（JWKS）で確かめる
 * - iss：提供元のもの。aud：このクライアント（複数なら azp もこのクライアント）
 * - exp、iat：期限内（時計のずれを少し許す）
 * - nonce：ログインを始めたときに渡したもの（ID トークンの使い回しを防ぐ）
 * - email_verified：提供元がメールを確認済みとしていること（docs/decisions/accounts.md の 3）
 */
export async function verifyIdToken(
  fetcher: typeof fetch,
  provider: OidcProvider,
  client: Pick<OAuthClient, "clientId">,
  idToken: string,
  input: { nonce: string; now: Date },
): Promise<VerifiedLogin> {
  const parts = idToken.split(".");
  const [header, payload, signature] = parts;
  if (parts.length !== 3 || header === undefined || payload === undefined || !signature) {
    throw new LoginError("invalid_id_token", "id token is not a JWS");
  }
  await verifySignature(fetcher, provider, { header, payload, signature });

  const parsed = IdTokenClaimsSchema.safeParse(decodeJsonPart(payload));
  if (!parsed.success) throw new LoginError("invalid_id_token", "id token claims are invalid");
  const claims = parsed.data;
  const now = input.now.getTime() / 1000;
  const audiences = typeof claims.aud === "string" ? [claims.aud] : claims.aud;
  const problems = [
    !provider.acceptedIssuers.includes(claims.iss) && `iss ${claims.iss}`,
    !audiences.includes(client.clientId) && "aud",
    audiences.length > 1 && claims.azp !== client.clientId && "azp",
    claims.exp + CLOCK_SKEW_SECONDS <= now && "expired",
    claims.iat - CLOCK_SKEW_SECONDS > now && "issued in the future",
    claims.nonce !== input.nonce && "nonce",
  ].filter((problem) => problem !== false);
  if (problems.length > 0) {
    throw new LoginError("invalid_id_token", `id token rejected: ${problems.join(", ")}`);
  }
  if (claims.email === undefined || claims.email_verified !== true) {
    throw new LoginError("email_not_verified", "the provider has not verified the email");
  }
  return { issuer: provider.issuer, subject: claims.sub, email: claims.email.toLowerCase() };
}
