import {
  type AuthInfo,
  createMcpHandler,
  getOAuthProtectedResourceMetadataUrl,
  originValidationResponse,
} from "@modelcontextprotocol/server";
import { Hono } from "hono";
import { authenticateOAuthAccessToken, OAUTH_ACCESS_TOKEN_PREFIX } from "../db/oauth";
import { authenticateToken, parseScopes } from "../db/tokens";
import { mcpResource } from "../oauth/authorize";
import type { OAuthServerConfig, Platform } from "../platform";
import { createMcpServer } from "./tools";

/*
 * リモート MCP サーバー（docs/decisions/mcp.md）。/mcp に、セッションを持たない Streamable HTTP で
 * 置く。2026-07-28 版の仕様のクライアントにも、2025 年の版のクライアントにも、リクエストごとに
 * 作り直したサーバーで答える（SDK の createMcpHandler）。
 *
 * 受けるトークンは 2 つ（決定の 2）。
 * - MCP 用のアクセストークン（sendo_ で始まる。/api/v1/tokens で発行する）
 * - OAuth で出したアクセストークン（sendo_at_ で始まる。宛先がこの MCP サーバーのものだけ）
 *
 * OAuth を設定していれば、401 の WWW-Authenticate に、保護されたリソースのメタデータの場所と、
 * 最初に求めてほしい範囲（read）を付ける（RFC 9728 の 5.1、MCP の仕様の「Scope Selection Strategy」）。
 */

/** OAuth を設定していれば、保護されたリソースのメタデータの URL */
function resourceMetadataUrl(config: OAuthServerConfig | undefined): string | undefined {
  return config && getOAuthProtectedResourceMetadataUrl(new URL(mcpResource(config)));
}

function unauthorized(config: OAuthServerConfig | undefined, description?: string) {
  const params = ['realm="sendo"'];
  // トークンを付けていないリクエストには、誤りの種類を付けない（RFC 6750 の 3.1）
  if (description !== undefined) {
    params.push('error="invalid_token"', `error_description="${description}"`);
  }
  const metadata = resourceMetadataUrl(config);
  if (metadata !== undefined) params.push('scope="read"', `resource_metadata="${metadata}"`);
  return new Response(
    JSON.stringify({
      error: "invalid_token",
      error_description: description ?? "a bearer token is required",
    }),
    {
      status: 401,
      headers: {
        "content-type": "application/json",
        "www-authenticate": `Bearer ${params.join(", ")}`,
      },
    },
  );
}

/** トークンを確かめ、ツールに渡す認証の情報を作る。使えないトークンなら undefined */
async function authenticate(platform: Platform, token: string): Promise<AuthInfo | undefined> {
  const config = platform.auth.oauth;
  const now = platform.now();
  const metadata = resourceMetadataUrl(config);

  // OAuth のトークン。宛先がこの MCP サーバーのものだけを受ける（RFC 8707、MCP の仕様の「Token Handling」）。
  // MCP 用のトークン（sendo_ と乱数）が、たまたま sendo_at_ で始まることもあるので、見つからなければ
  // MCP 用のトークンとしても引く
  if (config && token.startsWith(OAUTH_ACCESS_TOKEN_PREFIX)) {
    const auth = await authenticateOAuthAccessToken(platform.db, { token, now });
    if (auth) {
      if (auth.grant.resource !== mcpResource(config)) return undefined;
      return {
        token,
        clientId: auth.grant.clientId,
        scopes: parseScopes(auth.token.scopes),
        expiresAt: Math.floor(auth.token.expiresAt.getTime() / 1000),
        resource: new URL(auth.grant.resource),
        ...(metadata !== undefined && { resourceMetadataUrl: metadata }),
        extra: { userId: auth.user.id },
      };
    }
  }

  // MCP 用のトークンだけを受ける。アプリ用パスワード（リーダーアプリ用）は受けない（決定の 2）
  const auth = await authenticateToken(platform.db, { token, now, purpose: "mcp" });
  if (!auth) return undefined;
  return {
    token,
    clientId: `access-token:${auth.tokenId}`,
    scopes: auth.scopes,
    ...(metadata !== undefined && { resourceMetadataUrl: metadata }),
    extra: { userId: auth.user.id },
  };
}

export function mcpApp(platform: Platform) {
  const handler = createMcpHandler(({ authInfo }) => createMcpServer(platform, authInfo));
  const app = new Hono();

  app.all("/mcp", async (c) => {
    // ブラウザから来たリクエストは、Sendo 自身のオリジンからのものだけを受ける（DNS リバインディング
    // などで、ほかのサイトのページから送らせない）。Origin のないリクエスト（エージェント）は通す
    const rejected = originValidationResponse(c.req.raw, [new URL(c.req.url).hostname]);
    if (rejected) return rejected;

    const config = platform.auth.oauth;
    const token = /^Bearer\s+(\S+)\s*$/i.exec(c.req.header("authorization") ?? "")?.[1];
    if (token === undefined) return unauthorized(config);
    const authInfo = await authenticate(platform, token);
    if (!authInfo) return unauthorized(config, "the token is not valid for this MCP server");
    return handler.fetch(c.req.raw, { authInfo });
  });

  return app;
}
