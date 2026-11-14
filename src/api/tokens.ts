import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { AccessToken } from "../db/schema";
import {
  createAccessToken,
  deleteAccessToken,
  listAccessTokens,
  MAX_TOKEN_NAME_LENGTH,
  normalizeTokenName,
  parseScopes,
} from "../db/tokens";
import type { Platform } from "../platform";
import type { AuthVariables } from "./auth";
import { defaultHook } from "./hook";
import { ErrorSchema, errorBody } from "./schemas";

/*
 * アクセストークン（アプリ用パスワード）の発行・一覧・取り消し（docs/decisions/accounts.md の 7）。
 *
 * ブラウザでログインした人（セッション）だけが使える。アクセストークンでも使えると、Reeder などに
 * 入れたトークンが漏れたときに、それで新しいトークンを発行されて、漏れたものを取り消しても
 * 使われ続ける。
 */

const dateTime = z.iso.datetime();

const AccessTokenSchema = z
  .object({
    id: z.string(),
    name: z.string().openapi({ example: "Reeder" }),
    createdAt: dateTime,
    lastUsedAt: dateTime.nullable().openapi({
      description: "最後に使った時刻（1 時間ごとにしか更新しない）。使っていなければ null",
    }),
    purpose: z.enum(["reader", "mcp"]).openapi({
      description:
        "用途。reader はリーダーアプリ（Google Reader API）と REST API 用、mcp は /mcp（MCP サーバー）用。用途の違う入口では使えない",
    }),
    scopes: z.array(z.enum(["read", "write"])).openapi({
      description: "mcp の範囲。read は読むだけ、write は購読や既読などの変更も。reader は空",
    }),
  })
  .openapi("AccessToken");

function toAccessTokenResponse(token: AccessToken): z.infer<typeof AccessTokenSchema> {
  return {
    id: token.id,
    name: token.name,
    createdAt: token.createdAt.toISOString(),
    lastUsedAt: token.lastUsedAt?.toISOString() ?? null,
    purpose: token.purpose,
    scopes: parseScopes(token.scopes),
  };
}

const error = (description: string) => ({
  description,
  content: { "application/json": { schema: ErrorSchema } },
});

const sessionRequired = error("ブラウザのセッションではない（アクセストークンでは使えない）");

const listRoute = createRoute({
  method: "get",
  path: "/tokens",
  summary: "アクセストークンの一覧",
  description: "中身（sendo_ で始まる文字列）は、発行したときにしか返さない。",
  security: [{ sessionCookie: [] }],
  responses: {
    200: {
      description: "トークン（新しい順）",
      content: {
        "application/json": { schema: z.object({ items: z.array(AccessTokenSchema) }) },
      },
    },
    403: sessionRequired,
  },
});

const createTokenRoute = createRoute({
  method: "post",
  path: "/tokens",
  summary: "アクセストークンを発行する",
  description:
    "リーダーアプリ（Reeder、NetNewsWire など）のパスワード欄や、エージェント・スクリプトの Authorization: Bearer に使う。",
  security: [{ sessionCookie: [] }],
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z
            .object({
              name: z
                .string()
                .max(MAX_TOKEN_NAME_LENGTH * 2)
                .openapi({
                  description: `用途の名前（前後の空白を除いて 1〜${MAX_TOKEN_NAME_LENGTH} 文字）`,
                  example: "Reeder",
                }),
              purpose: z.enum(["reader", "mcp"]).optional().openapi({
                description:
                  "用途。既定は reader（リーダーアプリと REST API 用）。mcp なら /mcp でだけ使える",
              }),
              scopes: z
                .array(z.enum(["read", "write"]))
                .min(1)
                .max(2)
                .optional()
                .openapi({
                  description:
                    "mcp の範囲。既定は read（読むだけ）。write を含めると、購読や既読などの変更もできる（read も付く）。reader には付けられない",
                }),
            })
            .openapi("AccessTokenRequest"),
        },
      },
    },
  },
  responses: {
    201: {
      description: "発行した",
      content: {
        "application/json": {
          schema: z.object({
            token: z.string().openapi({
              description: "トークンの中身。この応答でしか返さないので、利用者に控えてもらう",
              example: "sendo_...",
            }),
            accessToken: AccessTokenSchema,
          }),
        },
      },
    },
    400: error("名前が空か長すぎる、reader に範囲を付けた"),
    403: sessionRequired,
  },
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/tokens/{id}",
  summary: "アクセストークンを取り消す",
  security: [{ sessionCookie: [] }],
  request: {
    params: z.object({
      id: z
        .string()
        .min(1)
        .max(64)
        .openapi({ param: { name: "id", in: "path" } }),
    }),
  },
  responses: {
    204: { description: "取り消した（そのトークンはすぐに使えなくなる）" },
    403: sessionRequired,
    404: error("トークンがない"),
  },
});

/** セッションで認証していなければ 403 の応答。していれば undefined */
function requireSession(c: Context<{ Variables: AuthVariables }>) {
  if (c.get("auth").kind === "session") return undefined;
  return c.json(
    errorBody("session_required", "sign in with a browser session to manage access tokens"),
    403,
  );
}

export function tokensApi(platform: Platform) {
  const { db } = platform;
  return new OpenAPIHono<{ Variables: AuthVariables }>({ defaultHook })
    .openapi(listRoute, async (c) => {
      const denied = requireSession(c);
      if (denied) return denied;
      const tokens = await listAccessTokens(db, c.get("user").id);
      return c.json({ items: tokens.map(toAccessTokenResponse) }, 200);
    })
    .openapi(createTokenRoute, async (c) => {
      const denied = requireSession(c);
      if (denied) return denied;
      const body = c.req.valid("json");
      const name = normalizeTokenName(body.name);
      if (name === null) {
        return c.json(
          errorBody("invalid_request", `name: 1-${MAX_TOKEN_NAME_LENGTH} characters`),
          400,
        );
      }
      const purpose = body.purpose ?? "reader";
      if (purpose === "reader" && body.scopes !== undefined) {
        return c.json(errorBody("invalid_request", "scopes: only for purpose mcp"), 400);
      }
      const { token, record } = await createAccessToken(db, {
        userId: c.get("user").id,
        name,
        now: platform.now(),
        purpose,
        scopes: body.scopes,
      });
      return c.json({ token, accessToken: toAccessTokenResponse(record) }, 201);
    })
    .openapi(deleteRoute, async (c) => {
      const denied = requireSession(c);
      if (denied) return denied;
      const { id } = c.req.valid("param");
      if (!(await deleteAccessToken(db, { userId: c.get("user").id, id }))) {
        return c.json(errorBody("not_found", "access token does not exist"), 404);
      }
      return c.body(null, 204);
    });
}
