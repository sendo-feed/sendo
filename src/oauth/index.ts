import { type AuthMetadataOptions, oauthMetadataResponse } from "@modelcontextprotocol/server";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { registerClient } from "../db/oauth";
import { readLimited, TooLargeError } from "../lib/read-limited";
import type { OAuthServerConfig, Platform } from "../platform";
import { mcpResource } from "./authorize";
import {
  isAllowedRedirectUri,
  MAX_CLIENT_NAME_LENGTH,
  MAX_REDIRECT_URIS,
  MAX_URI_LENGTH,
} from "./clients";
import { handleTokenRequest, TokenError } from "./token";

/*
 * OAuth の認可サーバーの入口のうち、クライアント（Claude.ai など）が Sendo に直接呼ぶもの
 * （docs/decisions/mcp.md の 3、5）。PUBLIC_URL と READER_URL を設定していなければ、どれも 404。
 *
 * - /.well-known/oauth-protected-resource/mcp：保護されたリソースのメタデータ（RFC 9728）
 * - /.well-known/oauth-authorization-server：認可サーバーのメタデータ（RFC 8414）
 * - /oauth/token：トークンのエンドポイント
 * - /oauth/register：動的登録（RFC 7591）
 *
 * 認可のエンドポイント（許可の画面）は sendo-reader にあり、そこから使う API は api/oauth.ts。
 * ブラウザで動くクライアントからも呼べるように、どれも CORS を許す（クッキーは使わない）。
 */

/** 本文の大きさの上限 */
const MAX_BODY_BYTES = 16 * 1024;

const CORS = { "access-control-allow-origin": "*" };

/** トークンや登録の応答は、キャッシュさせない（OAuth 2.1 の 3.2.3） */
const NO_STORE = { ...CORS, "cache-control": "no-store", pragma: "no-cache" };

/** メタデータ（SDK の oauthMetadataResponse が配る） */
export function metadataOptions(config: OAuthServerConfig): AuthMetadataOptions {
  const oauthMetadata = {
    issuer: config.issuer,
    authorization_endpoint: `${config.readerOrigin}/oauth/authorize`,
    token_endpoint: `${config.issuer}/oauth/token`,
    registration_endpoint: `${config.issuer}/oauth/register`,
    // 認可サーバーとしては両方を扱える。最初に求めてもらう範囲は、保護されたリソースの
    // メタデータの scopes_supported（read だけ）で示す（決定の 6）
    scopes_supported: ["read", "write"],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: true,
  };
  return {
    oauthMetadata,
    resourceServerUrl: new URL(mcpResource(config)),
    scopesSupported: ["read"],
    resourceName: "Sendo",
    // http は手元（localhost など）のときだけ。設定を読むときに確かめてある（platform/index.ts）
    dangerouslyAllowInsecureIssuerUrl: config.issuer.startsWith("http:"),
  };
}

/** OAuth の誤り（RFC 6749 の 5.2 の形） */
function oauthError(c: Context, status: 400 | 413, error: string, description: string) {
  return c.json({ error, error_description: description }, status, NO_STORE);
}

/** CORS の事前のリクエストに答える */
function preflight(c: Context) {
  return c.body(null, 204, {
    ...CORS,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers":
      c.req.header("access-control-request-headers") ?? "content-type",
    "access-control-max-age": "86400",
  });
}

/** 本文を、上限まで文字列で読む。超えたら TooLargeError */
async function readBody(c: Context): Promise<string> {
  const bytes = await readLimited(
    c.req.raw.body,
    c.req.header("content-length") ?? null,
    MAX_BODY_BYTES,
  );
  return new TextDecoder().decode(bytes);
}

/** Authorization: Basic のユーザー名（client_id）。秘密は見ない（公開クライアントだけ） */
function basicClientId(header: string | undefined): string | undefined {
  const encoded = /^Basic\s+(\S+)\s*$/i.exec(header ?? "")?.[1];
  if (encoded === undefined) return undefined;
  try {
    const decoded = atob(encoded);
    const end = decoded.indexOf(":");
    return decodeURIComponent(end < 0 ? decoded : decoded.slice(0, end));
  } catch {
    return undefined;
  }
}

const RegistrationSchema = z.looseObject({
  redirect_uris: z.array(z.string()).min(1).max(MAX_REDIRECT_URIS),
  client_name: z.string().optional(),
});

export function oauthApp(platform: Platform) {
  const app = new Hono();

  const metadata = (c: Context) => {
    const config = platform.auth.oauth;
    const res = config && oauthMetadataResponse(c.req.raw, metadataOptions(config));
    return res ?? c.notFound();
  };
  app.all("/.well-known/oauth-protected-resource/mcp", metadata);
  app.all("/.well-known/oauth-authorization-server", metadata);

  app.options("/oauth/token", (c) => (platform.auth.oauth ? preflight(c) : c.notFound()));
  app.post("/oauth/token", async (c) => {
    const config = platform.auth.oauth;
    if (!config) return c.notFound();
    if (!/^application\/x-www-form-urlencoded\b/i.test(c.req.header("content-type") ?? "")) {
      return oauthError(c, 400, "invalid_request", "use application/x-www-form-urlencoded");
    }
    let params: URLSearchParams;
    try {
      params = new URLSearchParams(await readBody(c));
    } catch (error) {
      if (error instanceof TooLargeError) {
        return oauthError(c, 413, "invalid_request", "request body is too large");
      }
      throw error;
    }
    for (const name of new Set(params.keys())) {
      if (params.getAll(name).length > 1) {
        return oauthError(c, 400, "invalid_request", `${name} is repeated`);
      }
    }
    // 公開クライアントは本文に client_id を書く。秘密なしの Basic で送ってくるクライアントも受ける
    const bodyClientId = params.get("client_id") ?? undefined;
    const headerClientId = basicClientId(c.req.header("authorization"));
    if (
      bodyClientId !== undefined &&
      headerClientId !== undefined &&
      bodyClientId !== headerClientId
    ) {
      return oauthError(
        c,
        400,
        "invalid_request",
        "client_id does not match the authorization header",
      );
    }
    try {
      const tokens = await handleTokenRequest(
        platform,
        config,
        params,
        bodyClientId ?? headerClientId,
      );
      return c.json(tokens, 200, NO_STORE);
    } catch (error) {
      if (error instanceof TokenError) return oauthError(c, 400, error.code, error.message);
      throw error;
    }
  });

  app.options("/oauth/register", (c) => (platform.auth.oauth ? preflight(c) : c.notFound()));
  app.post("/oauth/register", async (c) => {
    if (!platform.auth.oauth) return c.notFound();
    let body: unknown;
    try {
      body = JSON.parse(await readBody(c));
    } catch (error) {
      if (error instanceof TooLargeError) {
        return oauthError(c, 413, "invalid_client_metadata", "request body is too large");
      }
      return oauthError(c, 400, "invalid_client_metadata", "request body must be JSON");
    }
    const parsed = RegistrationSchema.safeParse(body);
    if (!parsed.success) {
      return oauthError(
        c,
        400,
        "invalid_client_metadata",
        `redirect_uris must be 1-${MAX_REDIRECT_URIS} strings, and client_name must be a string`,
      );
    }
    const redirectUris = parsed.data.redirect_uris;
    if (!redirectUris.every(isAllowedRedirectUri)) {
      return oauthError(
        c,
        400,
        "invalid_redirect_uri",
        `redirect_uris must be https or http on localhost (up to ${MAX_URI_LENGTH} characters, no fragment)`,
      );
    }
    const name = parsed.data.client_name?.trim() || null;
    if (name !== null && name.length > MAX_CLIENT_NAME_LENGTH) {
      return oauthError(c, 400, "invalid_client_metadata", "client_name is too long");
    }

    const client = await registerClient(platform.db, { name, redirectUris, now: platform.now() });
    // 求められた値のうち、Sendo が扱えないもの（秘密を使う認証など）は、扱えるものに置き換えて返す
    // （RFC 7591 の 3.2.1）。公開クライアントだけを登録する（決定の 5）
    return c.json(
      {
        client_id: client.id,
        client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
        ...(client.name !== null && { client_name: client.name }),
        redirect_uris: client.redirectUris,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
      201,
      NO_STORE,
    );
  });

  return app;
}
