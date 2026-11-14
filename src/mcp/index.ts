import {
  type AuthInfo,
  createMcpHandler,
  originValidationResponse,
} from "@modelcontextprotocol/server";
import { Hono } from "hono";
import { authenticateToken } from "../db/tokens";
import type { Platform } from "../platform";
import { createMcpServer } from "./tools";

/*
 * リモート MCP サーバー（docs/decisions/mcp.md）。/mcp に、セッションを持たない Streamable HTTP で
 * 置く。2026-07-28 版の仕様のクライアントにも、2025 年の版のクライアントにも、リクエストごとに
 * 作り直したサーバーで答える（SDK の createMcpHandler）。
 *
 * 認証は MCP 用のアクセストークン（決定の 2）。OAuth で出すトークンは、別の PR で足す。
 */

const unauthorized = (description: string) =>
  new Response(JSON.stringify({ error: "invalid_token", error_description: description }), {
    status: 401,
    headers: {
      "content-type": "application/json",
      "www-authenticate": `Bearer realm="sendo", error="invalid_token", error_description="${description}"`,
    },
  });

export function mcpApp(platform: Platform) {
  const handler = createMcpHandler(({ authInfo }) => createMcpServer(platform, authInfo));
  const app = new Hono();

  app.all("/mcp", async (c) => {
    // ブラウザから来たリクエストは、Sendo 自身のオリジンからのものだけを受ける（DNS リバインディング
    // などで、ほかのサイトのページから送らせない）。Origin のないリクエスト（エージェント）は通す
    const rejected = originValidationResponse(c.req.raw, [new URL(c.req.url).hostname]);
    if (rejected) return rejected;

    const token = /^Bearer\s+(\S+)\s*$/i.exec(c.req.header("authorization") ?? "")?.[1];
    if (token === undefined) return unauthorized("a bearer token is required");
    // MCP 用のトークンだけを受ける。アプリ用パスワード（リーダーアプリ用）は受けない（決定の 2）
    const auth = await authenticateToken(platform.db, {
      token,
      now: platform.now(),
      purpose: "mcp",
    });
    if (!auth) return unauthorized("the token is not valid for this MCP server");

    const authInfo: AuthInfo = {
      token,
      clientId: `access-token:${auth.tokenId}`,
      scopes: auth.scopes,
      extra: { userId: auth.user.id },
    };
    return handler.fetch(c.req.raw, { authInfo });
  });

  return app;
}
