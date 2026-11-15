import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { createGrant, deleteGrant, type GrantWithUsage, listGrants } from "../db/oauth";
import { parseScopes } from "../db/tokens";
import {
  type AuthorizationError,
  authorizationResponseUrl,
  parseAuthorizationRequest,
} from "../oauth/authorize";
import { isLoopbackRedirectUri, isMetadataDocumentClientId } from "../oauth/clients";
import type { Platform } from "../platform";
import type { AuthVariables } from "./auth";
import { defaultHook } from "./hook";
import { ErrorSchema, errorBody } from "./schemas";

/*
 * OAuth の許可の画面（sendo-reader の /oauth/authorize）が使う API と、出した許可の一覧・取り消し
 * （docs/decisions/mcp.md の 4、7）。
 *
 * ブラウザでログインした人（セッション）だけが使える。アクセストークンや MCP 用のトークンで使えると、
 * トークンを持ったエージェントが、自分で許可を出せてしまう。状態を変えるリクエストは、同じオリジンの
 * ページからだけ受ける（auth.ts の CSRF の対策）。
 */

const dateTime = z.iso.datetime();
const ScopesSchema = z.array(z.enum(["read", "write"])).openapi({
  description: "範囲。read は読むだけ、write は購読や既読などの変更も",
});

const QuerySchema = z.string().max(8192).openapi({
  description:
    "許可の画面の URL のクエリ文字列（location.search をそのまま。client_id、redirect_uri、state など）",
  example: "?response_type=code&client_id=https%3A%2F%2Fclient.example.com%2Fclient.json&...",
});

const AuthorizationRequestSchema = z
  .object({
    client: z.object({
      id: z.string().openapi({ description: "client_id" }),
      name: z.string().nullable().openapi({
        description:
          "クライアントの名前。kind が registered なら、クライアントが名乗っただけで確かめていない",
      }),
      kind: z.enum(["metadata_document", "registered"]).openapi({
        description:
          "metadata_document は、client_id の URL（host）から情報を取ったもの。registered は動的登録したもの",
      }),
      host: z.string().nullable().openapi({
        description:
          "client_id の URL のホスト（metadata_document のとき）。なりすましを見分けられるよう、画面に出す",
      }),
    }),
    redirectUri: z.string().openapi({ description: "許可したあとに戻る先" }),
    redirectHost: z.string().openapi({ description: "戻る先のホスト。画面に必ず出す" }),
    loopbackRedirect: z.boolean().openapi({
      description:
        "戻る先が手元（localhost など）か。ほかのアプリでも受けられるので、画面で注意を出す",
    }),
    scopes: ScopesSchema,
  })
  .openapi("OAuthAuthorizationRequest");

const AuthorizationErrorSchema = z
  .object({
    error: z.object({
      code: z.string().openapi({ example: "invalid_client" }),
      message: z.string(),
    }),
    redirectTo: z.string().optional().openapi({
      description:
        "あれば、誤りをクライアントに返すリダイレクト先。そこへブラウザを移す。なければ、画面に誤りを出す",
    }),
  })
  .openapi("OAuthAuthorizationError");

const GrantSchema = z
  .object({
    id: z.string(),
    clientId: z.string(),
    clientName: z.string().nullable().openapi({ description: "許可したときのクライアントの名前" }),
    clientKind: z.enum(["metadata_document", "registered"]),
    scopes: ScopesSchema,
    createdAt: dateTime.openapi({ description: "許可した時刻" }),
    lastUsedAt: dateTime.nullable().openapi({
      description:
        "最後にトークンを出した時刻。アクセストークンは 1 時間なので、使っていてもおよそ 1 時間ごとにしか変わらない。まだなら null",
    }),
  })
  .openapi("OAuthGrant");

function toGrantResponse(grant: GrantWithUsage): z.infer<typeof GrantSchema> {
  return {
    id: grant.id,
    clientId: grant.clientId,
    clientName: grant.clientName,
    clientKind: isMetadataDocumentClientId(grant.clientId) ? "metadata_document" : "registered",
    scopes: parseScopes(grant.scopes),
    createdAt: grant.createdAt.toISOString(),
    lastUsedAt: grant.lastUsedAt?.toISOString() ?? null,
  };
}

const error = (description: string) => ({
  description,
  content: { "application/json": { schema: ErrorSchema } },
});

const sessionRequired = error("ブラウザのセッションではない（アクセストークンでは使えない）");
const oauthDisabled = error("OAuth を使う設定（PUBLIC_URL と READER_URL）がない");
const authorizationError = {
  description: "認可のリクエストが正しくない",
  content: { "application/json": { schema: AuthorizationErrorSchema } },
};

const checkRoute = createRoute({
  method: "post",
  path: "/oauth/authorize/check",
  summary: "認可のリクエストを確かめる",
  description:
    "許可の画面を出す前に呼ぶ。クライアントの名前、戻る先、求められた範囲を返す。誤りなら、redirectTo があればそこへ移り、なければ画面に誤りを出す。",
  security: [{ sessionCookie: [] }],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: z.object({ query: QuerySchema }) } },
    },
  },
  responses: {
    200: {
      description: "正しいリクエスト。許可の画面を出す",
      content: { "application/json": { schema: AuthorizationRequestSchema } },
    },
    400: authorizationError,
    403: sessionRequired,
    404: oauthDisabled,
  },
});

const decideRoute = createRoute({
  method: "post",
  path: "/oauth/authorize/decide",
  summary: "許可か拒否を送る",
  description:
    "利用者が選んだ結果を送る。返した redirectTo（許可なら認可コード、拒否なら access_denied と、state と iss を付けたもの）へブラウザを移す。",
  security: [{ sessionCookie: [] }],
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({
            query: QuerySchema,
            approved: z.boolean().openapi({ description: "許可なら true、拒否なら false" }),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "クライアントへ戻る先",
      content: { "application/json": { schema: z.object({ redirectTo: z.string() }) } },
    },
    400: authorizationError,
    403: sessionRequired,
    404: oauthDisabled,
  },
});

const listGrantsRoute = createRoute({
  method: "get",
  path: "/oauth/grants",
  summary: "OAuth で出した許可の一覧",
  description: "まだ使える許可（新しい順）。",
  security: [{ sessionCookie: [] }],
  responses: {
    200: {
      description: "許可",
      content: { "application/json": { schema: z.object({ items: z.array(GrantSchema) }) } },
    },
    403: sessionRequired,
  },
});

const deleteGrantRoute = createRoute({
  method: "delete",
  path: "/oauth/grants/{id}",
  summary: "OAuth で出した許可を取り消す",
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
    204: { description: "取り消した（その許可のトークンは、すぐに使えなくなる）" },
    403: sessionRequired,
    404: error("許可がない"),
  },
});

/** セッションで認証していなければ 403 の応答。していれば undefined */
function requireSession(c: Context<{ Variables: AuthVariables }>) {
  if (c.get("auth").kind === "session") return undefined;
  return c.json(
    errorBody("session_required", "sign in with a browser session to authorize OAuth clients"),
    403,
  );
}

function authorizationErrorBody(error: AuthorizationError) {
  return {
    ...errorBody(error.code, error.message),
    ...(error.redirectTo !== undefined && { redirectTo: error.redirectTo }),
  };
}

export function oauthApi(platform: Platform) {
  const { db } = platform;
  const disabled = (c: Context) =>
    c.json(errorBody("oauth_disabled", "OAuth is not configured on this server"), 404);

  return new OpenAPIHono<{ Variables: AuthVariables }>({ defaultHook })
    .openapi(checkRoute, async (c) => {
      const denied = requireSession(c);
      if (denied) return denied;
      const config = platform.auth.oauth;
      if (!config) return disabled(c);
      const result = await parseAuthorizationRequest(platform, config, c.req.valid("json").query);
      if (!result.ok) return c.json(authorizationErrorBody(result.error), 400);
      const { client, redirectUri, scopes } = result.request;
      return c.json(
        {
          client: { id: client.id, name: client.name, kind: client.kind, host: client.host },
          redirectUri,
          redirectHost: new URL(redirectUri).host,
          loopbackRedirect: isLoopbackRedirectUri(redirectUri),
          scopes,
        },
        200,
      );
    })
    .openapi(decideRoute, async (c) => {
      const denied = requireSession(c);
      if (denied) return denied;
      const config = platform.auth.oauth;
      if (!config) return disabled(c);
      const body = c.req.valid("json");
      // 画面を出したあとにクライアントが変わっていないかも含め、もう一度すべて確かめる
      const result = await parseAuthorizationRequest(platform, config, body.query);
      if (!result.ok) return c.json(authorizationErrorBody(result.error), 400);
      const request = result.request;

      if (!body.approved) {
        const redirectTo = authorizationResponseUrl(request.redirectUri, config, {
          error: "access_denied",
          error_description: "the user denied the request",
          state: request.state,
        });
        return c.json({ redirectTo }, 200);
      }
      const { code } = await createGrant(db, {
        userId: c.get("user").id,
        clientId: request.client.id,
        clientName: request.client.name,
        scopes: request.scopes,
        resource: request.resource,
        redirectUri: request.redirectUri,
        codeChallenge: request.codeChallenge,
        now: platform.now(),
      });
      const redirectTo = authorizationResponseUrl(request.redirectUri, config, {
        code,
        state: request.state,
      });
      return c.json({ redirectTo }, 200);
    })
    .openapi(listGrantsRoute, async (c) => {
      const denied = requireSession(c);
      if (denied) return denied;
      const grants = await listGrants(db, { userId: c.get("user").id, now: platform.now() });
      return c.json({ items: grants.map(toGrantResponse) }, 200);
    })
    .openapi(deleteGrantRoute, async (c) => {
      const denied = requireSession(c);
      if (denied) return denied;
      const { id } = c.req.valid("param");
      if (!(await deleteGrant(db, { userId: c.get("user").id, id }))) {
        return c.json(errorBody("not_found", "grant does not exist"), 404);
      }
      return c.body(null, 204);
    });
}
