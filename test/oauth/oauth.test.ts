import { env } from "cloudflare:workers";
import {
  Client,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from "@modelcontextprotocol/client";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import { createPkce } from "../../src/auth/oidc";
import * as schema from "../../src/db/schema";
import type { OAuthServerConfig, Platform } from "../../src/platform";
import {
  createSessionHeaders,
  createTestPlatform,
  createUser,
  d1BeforeStatement,
  fakeFetch,
} from "../helpers";

const ISSUER = "https://sendo.example.com";
const READER = "https://reader.example.com";
const MCP_URL = `${ISSUER}/mcp`;
const OAUTH: OAuthServerConfig = { issuer: ISSUER, readerOrigin: READER };
const RESOURCE_METADATA = `${ISSUER}/.well-known/oauth-protected-resource/mcp`;

/** Client ID Metadata Document を出すクライアント */
const CLIENT_ID = "https://agent.example.com/oauth/client.json";
const REDIRECT_URI = "https://agent.example.com/callback";

type Json = Record<string, unknown>;

function clientDocument(overrides: Json = {}): Json {
  return {
    client_id: CLIENT_ID,
    client_name: "Agent",
    redirect_uris: [REDIRECT_URI, "http://127.0.0.1:33418/callback"],
    token_endpoint_auth_method: "none",
    ...overrides,
  };
}

/** CLIENT_ID の URL で、Client ID Metadata Document を返す fetch */
function documentFetch(respond: () => Response = () => Response.json(clientDocument())) {
  return fakeFetch((url) =>
    url.href === CLIENT_ID ? respond() : new Response("not found", { status: 404 }),
  );
}

/**
 * どの URL にも、client_id を clientId にした正しい文書を返す fetch。URL の形や SSRF の確認が
 * なければ通ってしまうことを確かめるのに使う
 */
function anyDocumentFetch(clientId: string): typeof fetch {
  return async () => Response.json(clientDocument({ client_id: clientId }));
}

/** OAuth を設定した Platform。時計は clock.now で進められる */
function setup(
  options: { fetch?: typeof fetch; oauth?: OAuthServerConfig | null; clock?: { now: number } } = {},
) {
  const clock = options.clock ?? { now: Date.now() };
  const { platform } = createTestPlatform({
    fetch: options.fetch ?? documentFetch().fetch,
    now: () => new Date(clock.now),
    auth: {
      allowedEmails: new Set(),
      google: undefined,
      oauth: options.oauth === null ? undefined : (options.oauth ?? OAUTH),
    },
  });
  return { platform, clock };
}

/** クライアント（Claude.ai など）から、Sendo に直接送る */
function sendo(platform: Platform, path: string, init?: RequestInit) {
  return createApp(platform).request(`${ISSUER}${path}`, init);
}

/** sendo-reader の許可の画面から、中継を通して Sendo の API を呼ぶ（ブラウザのセッションで） */
function readerApi(
  platform: Platform,
  headers: Record<string, string>,
  path: string,
  json: unknown,
) {
  return createApp(platform).request(`${READER}/api/v1${path}`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(json),
  });
}

/** 許可の画面の URL のクエリ。値を undefined にすると、その値を付けない */
function authorizeQuery(params: Record<string, string | undefined> = {}): string {
  const query = new URLSearchParams();
  const all = {
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    code_challenge: "x".repeat(43),
    code_challenge_method: "S256",
    state: "state-1",
    scope: "read",
    resource: MCP_URL,
    ...params,
  };
  for (const [name, value] of Object.entries(all)) {
    if (value !== undefined) query.append(name, value);
  }
  return `?${query}`;
}

async function session() {
  const user = await createUser();
  return { user, headers: await createSessionHeaders(user.id) };
}

/** 許可の画面で「許可」を選ぶ。戻る先の URL と、コードの交換に要るものを返す */
async function approve(
  platform: Platform,
  headers: Record<string, string>,
  params: Record<string, string | undefined> = {},
) {
  const pkce = await createPkce();
  const query = authorizeQuery({ code_challenge: pkce.challenge, ...params });
  const res = await readerApi(platform, headers, "/oauth/authorize/decide", {
    query,
    approved: true,
  });
  expect(res.status).toBe(200);
  const url = new URL(((await res.json()) as { redirectTo: string }).redirectTo);
  return { url, code: url.searchParams.get("code") ?? "", verifier: pkce.verifier };
}

function tokenRequest(
  platform: Platform,
  params: Record<string, string>,
  headers: Record<string, string> = {},
) {
  return sendo(platform, "/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(params).toString(),
  });
}

function exchange(
  platform: Platform,
  approved: { code: string; verifier: string },
  params: Record<string, string> = {},
) {
  return tokenRequest(platform, {
    grant_type: "authorization_code",
    code: approved.code,
    code_verifier: approved.verifier,
    redirect_uri: REDIRECT_URI,
    client_id: CLIENT_ID,
    resource: MCP_URL,
    ...params,
  });
}

type Tokens = {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
};

/** 許可してコードを換え、トークンを返す */
async function authorizeAndExchange(
  platform: Platform,
  headers: Record<string, string>,
  scope = "read",
) {
  const res = await exchange(platform, await approve(platform, headers, { scope }));
  expect(res.status).toBe(200);
  return (await res.json()) as Tokens;
}

function refresh(platform: Platform, token: string, params: Record<string, string> = {}) {
  return tokenRequest(platform, {
    grant_type: "refresh_token",
    refresh_token: token,
    client_id: CLIENT_ID,
    ...params,
  });
}

/** /mcp にツールの一覧を求め、応答を返す */
function mcp(platform: Platform, token: string | undefined, body?: Json) {
  return sendo(platform, "/mcp", {
    method: "POST",
    headers: {
      ...(token !== undefined && { authorization: `Bearer ${token}` }),
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body ?? { jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM oauth_grants; DELETE FROM oauth_clients;");
});

describe("OAuth のメタデータ", () => {
  it("保護されたリソースのメタデータは、宛先と認可サーバーと、最初に求める範囲（read）を示す", async () => {
    const { platform } = setup();

    const res = await sendo(platform, "/.well-known/oauth-protected-resource/mcp");

    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(await res.json()).toMatchObject({
      resource: MCP_URL,
      authorization_servers: [ISSUER],
      scopes_supported: ["read"],
    });
  });

  it("認可サーバーのメタデータは、許可の画面（sendo-reader）と、PKCE・iss・CIMD に対応していることを示す", async () => {
    const { platform } = setup();

    const res = await sendo(platform, "/.well-known/oauth-authorization-server");

    expect(await res.json()).toMatchObject({
      issuer: ISSUER,
      authorization_endpoint: `${READER}/oauth/authorize`,
      token_endpoint: `${ISSUER}/oauth/token`,
      registration_endpoint: `${ISSUER}/oauth/register`,
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      authorization_response_iss_parameter_supported: true,
      client_id_metadata_document_supported: true,
    });
  });

  it("/mcp の 401 は、メタデータの場所と範囲を示す。トークンがなければ誤りの種類は付けない", async () => {
    const { platform } = setup();

    const none = (await mcp(platform, undefined)).headers.get("www-authenticate") ?? "";
    expect(none).toContain(`resource_metadata="${RESOURCE_METADATA}"`);
    expect(none).toContain('scope="read"');
    expect(none).not.toContain("error=");

    const wrong = await mcp(platform, "sendo_at_unknown");
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });

  it("OAuth を設定していなければ、どの入口も 404 で、/mcp の 401 にメタデータの場所を付けない", async () => {
    const { platform } = setup({ oauth: null });
    const { headers } = await session();

    for (const path of [
      "/.well-known/oauth-protected-resource/mcp",
      "/.well-known/oauth-authorization-server",
    ]) {
      expect((await sendo(platform, path)).status, path).toBe(404);
    }
    expect((await tokenRequest(platform, { grant_type: "refresh_token" })).status).toBe(404);
    expect((await sendo(platform, "/oauth/register", { method: "POST", body: "{}" })).status).toBe(
      404,
    );
    const check = await readerApi(platform, headers, "/oauth/authorize/check", {
      query: authorizeQuery(),
    });
    expect(check.status).toBe(404);
    expect((await mcp(platform, undefined)).headers.get("www-authenticate")).not.toContain(
      "resource_metadata",
    );
  });
});

describe("動的登録（/oauth/register）", () => {
  const register = (platform: Platform, body: unknown) =>
    sendo(platform, "/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("公開クライアントとして登録する。秘密を使う認証を求められても none に置き換える", async () => {
    const { platform } = setup();

    const res = await register(platform, {
      client_name: " Claude ",
      redirect_uris: ["https://claude.example.com/callback", "http://localhost:6274/cb"],
      token_endpoint_auth_method: "client_secret_basic",
      grant_types: ["authorization_code", "refresh_token", "client_credentials"],
    });

    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as Json;
    expect(body).toMatchObject({
      client_name: "Claude",
      redirect_uris: ["https://claude.example.com/callback", "http://localhost:6274/cb"],
      grant_types: ["authorization_code", "refresh_token"],
      token_endpoint_auth_method: "none",
    });
    expect(body.client_id).toEqual(expect.any(String));
    expect(body).not.toHaveProperty("client_secret");
  });

  it("リダイレクト先が https か localhost の http でなければ受けない", async () => {
    const { platform } = setup();

    for (const uri of [
      "http://agent.example.com/callback",
      "https://agent.example.com/callback#fragment",
      "cursor://anysphere.cursor-retrieval/oauth/callback",
      "https://user:pass@agent.example.com/callback",
    ]) {
      const res = await register(platform, { redirect_uris: [uri] });
      expect(res.status, uri).toBe(400);
      expect(((await res.json()) as Json).error, uri).toBe("invalid_redirect_uri");
    }
    const missing = await register(platform, { client_name: "x" });
    expect(((await missing.json()) as Json).error).toBe("invalid_client_metadata");
  });

  it("一度も許可されないまま 1 日たったクライアントは、次の登録で消す。一度許可されたものは、許可を取り消しても残す", async () => {
    const clock = { now: Date.now() };
    const { platform } = setup({ clock });
    const { headers } = await session();
    const body = { redirect_uris: [REDIRECT_URI] };
    const unused = (await (await register(platform, body)).json()) as { client_id: string };
    const used = (await (await register(platform, body)).json()) as { client_id: string };
    await approve(platform, headers, { client_id: used.client_id });
    await env.DB.exec("DELETE FROM oauth_grants");

    clock.now += 25 * 60 * 60 * 1000;
    await register(platform, body);

    const ids = (await env.DB.prepare("SELECT id FROM oauth_clients").all<{ id: string }>())
      .results;
    expect(ids.map((row) => row.id)).toContain(used.client_id);
    expect(ids.map((row) => row.id)).not.toContain(unused.client_id);
    const check = await readerApi(platform, headers, "/oauth/authorize/check", {
      query: authorizeQuery({ client_id: used.client_id }),
    });
    expect(check.status).toBe(200);
  });
});

describe("許可の画面の API（/api/v1/oauth/authorize）", () => {
  it("Client ID Metadata Document を取りにいき、名前・ホスト・戻る先・範囲を返す", async () => {
    const { fetch, calls } = documentFetch();
    const { platform } = setup({ fetch });
    const { headers } = await session();

    const res = await readerApi(platform, headers, "/oauth/authorize/check", {
      query: authorizeQuery({ scope: "write offline_access" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      client: {
        id: CLIENT_ID,
        name: "Agent",
        kind: "metadata_document",
        host: "agent.example.com",
      },
      redirectUri: REDIRECT_URI,
      redirectHost: "agent.example.com",
      loopbackRedirect: false,
      scopes: ["read", "write"],
    });
    expect(calls.map((call) => call.url)).toEqual([CLIENT_ID]);
  });

  it("範囲を付けなければ read。localhost に戻るなら、そう示す", async () => {
    const { platform } = setup();
    const { headers } = await session();

    const res = await readerApi(platform, headers, "/oauth/authorize/check", {
      query: authorizeQuery({ scope: undefined, redirect_uri: "http://127.0.0.1:33418/callback" }),
    });

    expect(await res.json()).toMatchObject({ loopbackRedirect: true, scopes: ["read"] });
  });

  it("クライアントか戻る先が確かめられなければ、クライアントに返さず、画面に誤りを出させる", async () => {
    const { headers } = await session();
    const cases: [string, typeof fetch | undefined, Record<string, string | undefined>, string][] =
      [
        ["client_id がない", undefined, { client_id: undefined }, "invalid_request"],
        [
          "文書の client_id が違う",
          documentFetch(() =>
            Response.json(clientDocument({ client_id: "https://agent.example.com/other.json" })),
          ).fetch,
          {},
          "invalid_client",
        ],
        [
          "文書に秘密がある",
          documentFetch(() => Response.json(clientDocument({ client_secret: "s" }))).fetch,
          {},
          "invalid_client",
        ],
        [
          "秘密を使う認証",
          documentFetch(() =>
            Response.json(clientDocument({ token_endpoint_auth_method: "client_secret_basic" })),
          ).fetch,
          {},
          "invalid_client",
        ],
        [
          "200 でない（中身が正しくても受けない）",
          documentFetch(() => Response.json(clientDocument(), { status: 404 })).fetch,
          {},
          "invalid_client",
        ],
        [
          "文書が大きすぎる",
          documentFetch(() => Response.json(clientDocument({ padding: "x".repeat(6000) }))).fetch,
          {},
          "invalid_client",
        ],
        [
          "リダイレクトはたどらない",
          documentFetch(
            () =>
              new Response(null, {
                status: 302,
                headers: { location: "https://evil.example.com/client.json" },
              }),
          ).fetch,
          {},
          "invalid_client",
        ],
        ["JSON でない", documentFetch(() => new Response("<html>")).fetch, {}, "invalid_client"],
        [
          "内部のホスト（取りにいかない）",
          anyDocumentFetch("https://127.0.0.1/client.json"),
          { client_id: "https://127.0.0.1/client.json" },
          "invalid_client",
        ],
        [
          "正規化されていない URL",
          anyDocumentFetch("https://AGENT.example.com/oauth/client.json"),
          { client_id: "https://AGENT.example.com/oauth/client.json" },
          "invalid_client",
        ],
        [
          "パスがない",
          anyDocumentFetch("https://agent.example.com/"),
          { client_id: "https://agent.example.com/" },
          "invalid_client",
        ],
        ["登録していない ID", undefined, { client_id: "unknown-client" }, "invalid_client"],
        [
          "登録していない戻る先",
          undefined,
          { redirect_uri: "https://evil.example.com/callback" },
          "invalid_redirect_uri",
        ],
        ["戻る先がない", undefined, { redirect_uri: undefined }, "invalid_request"],
      ];

    for (const [name, fetch, params, code] of cases) {
      const { platform } = setup(fetch === undefined ? {} : { fetch });
      const res = await readerApi(platform, headers, "/oauth/authorize/check", {
        query: authorizeQuery(params),
      });
      expect(res.status, name).toBe(400);
      const body = (await res.json()) as { error: { code: string }; redirectTo?: string };
      expect(body.error.code, name).toBe(code);
      expect(body.redirectTo, name).toBeUndefined();
    }
  });

  it("クライアントと戻る先を確かめたあとの誤りは、error と state と iss を付けて、戻る先に返す", async () => {
    const { platform } = setup();
    const { headers } = await session();
    const cases: [string, Record<string, string | undefined>, string][] = [
      ["response_type が code でない", { response_type: "token" }, "unsupported_response_type"],
      ["PKCE がない", { code_challenge: undefined }, "invalid_request"],
      ["PKCE が plain", { code_challenge_method: "plain" }, "invalid_request"],
      ["宛先がほかのサーバー", { resource: "https://other.example.com/mcp" }, "invalid_target"],
    ];

    for (const [name, params, code] of cases) {
      const res = await readerApi(platform, headers, "/oauth/authorize/check", {
        query: authorizeQuery(params),
      });
      expect(res.status, name).toBe(400);
      const body = (await res.json()) as { redirectTo: string };
      const url = new URL(body.redirectTo);
      expect(url.origin + url.pathname, name).toBe(REDIRECT_URI);
      expect(url.searchParams.get("error"), name).toBe(code);
      expect(url.searchParams.get("state"), name).toBe("state-1");
      expect(url.searchParams.get("iss"), name).toBe(ISSUER);
    }

    const repeated = await readerApi(platform, headers, "/oauth/authorize/check", {
      query: `${authorizeQuery()}&scope=write`,
    });
    const { redirectTo } = (await repeated.json()) as { redirectTo: string };
    expect(new URL(redirectTo).searchParams.get("error")).toBe("invalid_request");
  });

  it("拒否すると access_denied を返す。許可するとコードを返す。どちらも state と iss を付ける", async () => {
    const { platform } = setup();
    const { headers } = await session();

    const denied = await readerApi(platform, headers, "/oauth/authorize/decide", {
      query: authorizeQuery(),
      approved: false,
    });
    const deniedUrl = new URL(((await denied.json()) as { redirectTo: string }).redirectTo);
    expect(deniedUrl.searchParams.get("error")).toBe("access_denied");
    expect(deniedUrl.searchParams.get("state")).toBe("state-1");
    expect(deniedUrl.searchParams.get("iss")).toBe(ISSUER);
    expect(deniedUrl.searchParams.has("code")).toBe(false);

    const { url } = await approve(platform, headers);
    expect(url.origin + url.pathname).toBe(REDIRECT_URI);
    expect(url.searchParams.get("code")).toEqual(expect.any(String));
    expect(url.searchParams.get("state")).toBe("state-1");
    expect(url.searchParams.get("iss")).toBe(ISSUER);
  });

  it("戻る先にもとからあるクエリは残す", async () => {
    const withQuery = "https://agent.example.com/callback?tenant=a";
    const { platform } = setup({
      fetch: documentFetch(() => Response.json(clientDocument({ redirect_uris: [withQuery] })))
        .fetch,
    });
    const { headers } = await session();

    const { url } = await approve(platform, headers, { redirect_uri: withQuery });

    expect(url.searchParams.get("tenant")).toBe("a");
    expect(url.searchParams.get("code")).toEqual(expect.any(String));
  });

  it("ブラウザのセッションでだけ使える。トークンでは 403、ほかのサイトからは 403、ログインしていなければ 401", async () => {
    const { platform } = setup();
    const { user, headers } = await session();
    const body = { query: authorizeQuery(), approved: true };

    const withToken = await createApp(platform).request(`${READER}/api/v1/oauth/authorize/decide`, {
      method: "POST",
      headers: { authorization: `Bearer ${user.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(withToken.status).toBe(403);
    expect(((await withToken.json()) as { error: { code: string } }).error.code).toBe(
      "session_required",
    );

    const crossSite = await readerApi(
      platform,
      { ...headers, "sec-fetch-site": "cross-site" },
      "/oauth/authorize/decide",
      body,
    );
    expect(crossSite.status).toBe(403);

    const anonymous = await readerApi(platform, {}, "/oauth/authorize/decide", body);
    expect(anonymous.status).toBe(401);

    const grants = await env.DB.prepare("SELECT count(*) AS n FROM oauth_grants").first<{
      n: number;
    }>();
    expect(grants?.n).toBe(0);
  });
});

describe("トークンのエンドポイント（/oauth/token）", () => {
  it("コードを、1 時間のアクセストークンとリフレッシュトークンに換える。アクセストークンで /mcp を使える", async () => {
    const { platform } = setup();
    const { headers } = await session();

    const res = await exchange(platform, await approve(platform, headers));

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const tokens = (await res.json()) as Tokens;
    expect(tokens).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "read" });
    expect(tokens.access_token.startsWith("sendo_at_")).toBe(true);
    expect(tokens.refresh_token.startsWith("sendo_rt_")).toBe(true);
    expect((await mcp(platform, tokens.access_token)).status).toBe(200);
  });

  it("使ったコードがもう一度来たら、許可ごと取り消す（先に出したトークンも使えなくなる）", async () => {
    const { platform } = setup();
    const { headers } = await session();
    const approved = await approve(platform, headers);
    const tokens = (await (await exchange(platform, approved)).json()) as Tokens;

    const again = await exchange(platform, approved);

    expect(again.status).toBe(400);
    expect(((await again.json()) as Json).error).toBe("invalid_grant");
    expect((await mcp(platform, tokens.access_token)).status).toBe(401);
    expect((await refresh(platform, tokens.refresh_token)).status).toBe(400);
  });

  it("PKCE、戻る先、クライアント、期限、宛先が合わなければ、コードを換えない", async () => {
    const clock = { now: Date.now() };
    const { platform } = setup({ clock });
    const { headers } = await session();
    const cases: [string, Record<string, string>, string, number?][] = [
      ["code_verifier が違う", { code_verifier: "a".repeat(43) }, "invalid_grant"],
      ["戻る先が違う", { redirect_uri: "http://127.0.0.1:33418/callback" }, "invalid_grant"],
      [
        "クライアントが違う",
        { client_id: "https://other.example.com/client.json" },
        "invalid_grant",
      ],
      ["宛先が違う", { resource: "https://other.example.com/mcp" }, "invalid_target"],
      ["期限が切れた", {}, "invalid_grant", 6 * 60 * 1000],
    ];

    for (const [name, params, code, wait] of cases) {
      const approved = await approve(platform, headers);
      clock.now += wait ?? 0;
      const res = await exchange(platform, approved, params);
      expect(res.status, name).toBe(400);
      expect(((await res.json()) as Json).error, name).toBe(code);
    }
  });

  it("同じコードが同時に 2 回来たら、片方しか通さず、許可ごと取り消す", async () => {
    const { platform } = setup();
    const { headers } = await session();
    const approved = await approve(platform, headers);
    // コードに使った印を付ける文の直前に、もう一方のリクエストが同じコードを使う
    const hooked = d1BeforeStatement(/^\s*update\s+"oauth_codes"/i, async () => {
      await env.DB.prepare("UPDATE oauth_codes SET used_at = ?").bind(Date.now()).run();
    });

    const res = await exchange({ ...platform, db: drizzle(hooked.db, { schema }) }, approved);

    expect(hooked.fired()).toBe(true);
    expect(((await res.json()) as Json).error).toBe("invalid_grant");
    const grants = await env.DB.prepare("SELECT count(*) AS n FROM oauth_grants").first<{
      n: number;
    }>();
    expect(grants?.n).toBe(0);
  });

  it("同じリフレッシュトークンが同時に 2 回来たら、片方しか通さず、許可ごと取り消す", async () => {
    const { platform } = setup();
    const { headers } = await session();
    const tokens = await authorizeAndExchange(platform, headers);
    // 作り直した印を付ける文の直前に、もう一方のリクエストが同じトークンを作り直す
    const hooked = d1BeforeStatement(/^\s*update\s+"oauth_tokens"/i, async () => {
      await env.DB.prepare("UPDATE oauth_tokens SET rotated_at = ? WHERE kind = 'refresh'")
        .bind(Date.now())
        .run();
    });

    const res = await refresh(
      { ...platform, db: drizzle(hooked.db, { schema }) },
      tokens.refresh_token,
    );

    expect(hooked.fired()).toBe(true);
    expect(((await res.json()) as Json).error).toBe("invalid_grant");
    expect((await mcp(platform, tokens.access_token)).status).toBe(401);
  });

  it("リフレッシュトークンを作り直している途中に、同じ人がほかの許可を出しても、この許可は消えない", async () => {
    const clock = { now: Date.now() };
    const { platform } = setup({ clock });
    const { headers } = await session();
    const tokens = await authorizeAndExchange(platform, headers);
    clock.now += 10 * 60 * 1000;
    // 新しいトークンを入れる文の直前に、ほかの許可（使えない許可の掃除）が走る
    const hooked = d1BeforeStatement(/^\s*insert\s+into\s+"oauth_tokens"/i, async () => {
      await approve(platform, headers);
    });

    const res = await refresh(
      { ...platform, db: drizzle(hooked.db, { schema }) },
      tokens.refresh_token,
    );

    expect(hooked.fired()).toBe(true);
    expect(res.status).toBe(200);
    const renewed = (await res.json()) as Tokens;
    expect((await mcp(platform, renewed.access_token)).status).toBe(200);
  });

  it("コードを期限ぎりぎりに換える途中で、同じ人がほかの許可を出しても、この許可は消えない", async () => {
    const clock = { now: Date.now() };
    const { platform } = setup({ clock });
    const { headers } = await session();
    const approved = await approve(platform, headers);
    clock.now += 5 * 60 * 1000 - 1;
    // トークンを入れる文の直前に、コードの期限を過ぎてから、ほかの許可（掃除）が走る
    const hooked = d1BeforeStatement(/^\s*insert\s+into\s+"oauth_tokens"/i, async () => {
      clock.now += 1000;
      await approve(platform, headers);
    });

    const res = await exchange({ ...platform, db: drizzle(hooked.db, { schema }) }, approved);

    expect(hooked.fired()).toBe(true);
    expect(res.status).toBe(200);
  });

  it("client_id は、秘密なしの Basic でも受ける。本文と食い違えば受けない", async () => {
    const { platform } = setup();
    const { headers } = await session();
    const basic = `Basic ${btoa(`${encodeURIComponent(CLIENT_ID)}:`)}`;
    const approved = await approve(platform, headers);

    const params = {
      grant_type: "authorization_code",
      code: approved.code,
      code_verifier: approved.verifier,
      redirect_uri: REDIRECT_URI,
    };

    // 食い違えば、コードを使わずに断る（そのあと正しく送れば換えられる）
    const mismatch = await tokenRequest(
      platform,
      { ...params, client_id: "other" },
      { authorization: basic },
    );
    expect(((await mismatch.json()) as Json).error).toBe("invalid_request");

    const res = await tokenRequest(platform, params, { authorization: basic });
    expect(res.status).toBe(200);
  });

  it("リフレッシュトークンを使うたびに作り直す。古いものがもう一度来たら、許可ごと取り消す", async () => {
    const { platform } = setup();
    const { headers } = await session();
    const first = await authorizeAndExchange(platform, headers);
    const otherClient = await refresh(platform, first.refresh_token, {
      client_id: "https://other.example.com/client.json",
    });
    expect(((await otherClient.json()) as Json).error).toBe("invalid_grant");

    const second = (await (await refresh(platform, first.refresh_token)).json()) as Tokens;
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect((await mcp(platform, second.access_token)).status).toBe(200);

    const reused = await refresh(platform, first.refresh_token);
    expect(reused.status).toBe(400);
    expect(((await reused.json()) as Json).error).toBe("invalid_grant");
    expect((await mcp(platform, second.access_token)).status).toBe(401);
    expect((await refresh(platform, second.refresh_token)).status).toBe(400);
  });

  it("更新では、許可の範囲の中で狭められ、広げられない", async () => {
    const { platform } = setup();
    const { headers } = await session();
    const tokens = await authorizeAndExchange(platform, headers, "read write");
    expect(tokens.scope).toBe("read write");

    const narrowed = (await (
      await refresh(platform, tokens.refresh_token, { scope: "read" })
    ).json()) as Tokens;
    expect(narrowed.scope).toBe("read");
    const full = (await (await refresh(platform, narrowed.refresh_token)).json()) as Tokens;
    expect(full.scope).toBe("read write");

    const readOnly = await authorizeAndExchange(platform, headers, "read");
    const widened = await refresh(platform, readOnly.refresh_token, { scope: "read write" });
    expect(((await widened.json()) as Json).error).toBe("invalid_scope");
  });

  it("アクセストークンは 1 時間、リフレッシュトークンは 30 日で使えなくなる", async () => {
    const clock = { now: Date.now() };
    const { platform } = setup({ clock });
    const { headers } = await session();
    const tokens = await authorizeAndExchange(platform, headers);

    clock.now += 60 * 60 * 1000;
    expect((await mcp(platform, tokens.access_token)).status).toBe(401);
    clock.now += 30 * 24 * 60 * 60 * 1000;
    const expired = await refresh(platform, tokens.refresh_token);
    expect(((await expired.json()) as Json).error).toBe("invalid_grant");
  });

  it("OAuth のトークンは、REST API と Google Reader API では使えない", async () => {
    const { platform } = setup();
    const { headers } = await session();
    const tokens = await authorizeAndExchange(platform, headers, "read write");

    for (const token of [tokens.access_token, tokens.refresh_token]) {
      const rest = await sendo(platform, "/api/v1/feeds", {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(rest.status).toBe(401);
      const greader = await sendo(platform, "/reader/api/0/user-info", {
        headers: { authorization: `GoogleLogin auth=${token}` },
      });
      expect(greader.status).toBe(401);
    }
    expect((await mcp(platform, tokens.refresh_token)).status).toBe(401);
  });

  it("PUBLIC_URL を変えたら、前の宛先のトークンは /mcp でも更新でも使えない", async () => {
    const { platform } = setup();
    const { headers } = await session();
    const tokens = await authorizeAndExchange(platform, headers);

    const moved = setup({ oauth: { issuer: "https://new.example.com", readerOrigin: READER } });

    expect((await mcp(moved.platform, tokens.access_token)).status).toBe(401);
    const res = await refresh(moved.platform, tokens.refresh_token);
    expect(((await res.json()) as Json).error).toBe("invalid_grant");
  });

  it("form でない本文や、知らない grant_type は受けない", async () => {
    const { platform } = setup();

    const json = await sendo(platform, "/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant_type: "authorization_code" }),
    });
    expect(((await json.json()) as Json).error).toBe("invalid_request");
    const unknown = await tokenRequest(platform, {
      grant_type: "client_credentials",
      client_id: CLIENT_ID,
    });
    expect(((await unknown.json()) as Json).error).toBe("unsupported_grant_type");
  });
});

describe("read だけの許可", () => {
  it("状態を変えるツールは 403 insufficient_scope で、メタデータの場所と、要る範囲（read write）を示す", async () => {
    const { platform } = setup();
    const { headers } = await session();
    const tokens = await authorizeAndExchange(platform, headers, "read");
    const call = (name: string, args: Json) =>
      mcp(platform, tokens.access_token, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name, arguments: args },
      });

    expect((await call("list_feeds", {})).status).toBe(200);
    const res = await call("mark_read", { ids: ["x"] });

    expect(res.status).toBe(403);
    const challenge = res.headers.get("www-authenticate") ?? "";
    expect(challenge).toContain('error="insufficient_scope"');
    expect(challenge).toContain('scope="read write"');
    expect(challenge).toContain(`resource_metadata="${RESOURCE_METADATA}"`);
  });
});

describe("出した許可の一覧と取り消し（/api/v1/oauth/grants）", () => {
  const listGrants = async (platform: Platform, headers: Record<string, string>) => {
    const res = await createApp(platform).request(`${READER}/api/v1/oauth/grants`, { headers });
    return ((await res.json()) as { items: Json[] }).items;
  };

  it("一覧に出し、取り消すと、トークンがすぐに使えなくなる。ほかの人の許可は取り消せない", async () => {
    const { platform } = setup();
    const { headers } = await session();
    const other = await session();
    const tokens = await authorizeAndExchange(platform, headers, "read write");

    const items = await listGrants(platform, headers);
    expect(items).toEqual([
      expect.objectContaining({
        clientId: CLIENT_ID,
        clientName: "Agent",
        clientKind: "metadata_document",
        scopes: ["read", "write"],
        lastUsedAt: expect.any(String),
      }),
    ]);
    expect(await listGrants(platform, other.headers)).toEqual([]);
    const id = String(items[0]?.id);

    const remove = (h: Record<string, string>) =>
      createApp(platform).request(`${READER}/api/v1/oauth/grants/${id}`, {
        method: "DELETE",
        headers: h,
      });
    expect((await remove(other.headers)).status).toBe(404);
    expect((await mcp(platform, tokens.access_token)).status).toBe(200);
    expect((await remove(headers)).status).toBe(204);
    expect((await mcp(platform, tokens.access_token)).status).toBe(401);
    expect((await refresh(platform, tokens.refresh_token)).status).toBe(400);
    expect(await listGrants(platform, headers)).toEqual([]);
  });

  it("使えなくなった許可（コードを換えないまま期限が切れたもの）は一覧に出さず、次に許可するときに消す。トークンのある許可は残す", async () => {
    const clock = { now: Date.now() };
    const { platform } = setup({ clock });
    const { user, headers } = await session();
    await approve(platform, headers);
    await authorizeAndExchange(platform, headers);
    expect(await listGrants(platform, headers)).toHaveLength(2);

    clock.now += 7 * 60 * 1000;
    const items = await listGrants(platform, headers);
    expect(items).toEqual([expect.objectContaining({ lastUsedAt: expect.any(String) })]);
    await approve(platform, headers);

    const rows = await env.DB.prepare("SELECT count(*) AS n FROM oauth_grants WHERE user_id = ?")
      .bind(user.id)
      .first<{ n: number }>();
    expect(rows?.n).toBe(2);
    expect(await listGrants(platform, headers)).toHaveLength(2);
  });
});

/** テストの MCP のクライアント。トークンなどを覚えておき、許可の画面へ移る代わりに URL を記録する */
class TestProvider implements OAuthClientProvider {
  readonly clientMetadataUrl?: string;
  authorizationUrl: URL | undefined;
  private info: StoredOAuthClientInformation | undefined;
  private saved: StoredOAuthTokens | undefined;
  private verifier = "";
  private discovery: OAuthDiscoveryState | undefined;

  constructor(clientMetadataUrl?: string) {
    if (clientMetadataUrl !== undefined) this.clientMetadataUrl = clientMetadataUrl;
  }

  get redirectUrl() {
    return REDIRECT_URI;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Agent",
      redirect_uris: [REDIRECT_URI],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  clientInformation() {
    return this.info;
  }
  saveClientInformation(info: StoredOAuthClientInformation) {
    this.info = info;
  }
  tokens() {
    return this.saved;
  }
  saveTokens(tokens: StoredOAuthTokens) {
    this.saved = tokens;
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
  }
  saveCodeVerifier(verifier: string) {
    this.verifier = verifier;
  }
  codeVerifier() {
    return this.verifier;
  }
  saveDiscoveryState(state: OAuthDiscoveryState) {
    this.discovery = state;
  }
  discoveryState() {
    return this.discovery;
  }
}

describe("公式のクライアントで、OAuth でつなぐ", () => {
  /**
   * 401 から、メタデータを見つけ、許可の画面（sendo-reader）で許可し、コードをトークンに換えて、
   * つなぎ直すまでを通す
   */
  async function connectWithOAuth(platform: Platform, provider: TestProvider) {
    const { headers } = await session();
    const fetchApp: typeof fetch = async (input, init) =>
      createApp(platform).request(input instanceof Request ? input : String(input), init);
    const transport = () =>
      new StreamableHTTPClientTransport(new URL(MCP_URL), {
        fetch: fetchApp,
        authProvider: provider,
      });

    const first = transport();
    await expect(
      new Client({ name: "agent", version: "0.0.0" }).connect(first),
    ).rejects.toBeInstanceOf(UnauthorizedError);

    const authorizationUrl = provider.authorizationUrl;
    if (!authorizationUrl) throw new Error("the client did not start the authorization");
    expect(`${authorizationUrl.origin}${authorizationUrl.pathname}`).toBe(
      `${READER}/oauth/authorize`,
    );
    expect(authorizationUrl.searchParams.get("resource")).toBe(MCP_URL);
    expect(authorizationUrl.searchParams.get("scope")).toBe("read");

    // sendo-reader の画面の代わりに、クエリをそのまま API に渡して許可する
    const decided = await readerApi(platform, headers, "/oauth/authorize/decide", {
      query: authorizationUrl.search,
      approved: true,
    });
    const { redirectTo } = (await decided.json()) as { redirectTo: string };
    await first.finishAuth(new URL(redirectTo).searchParams);

    const client = new Client({ name: "agent", version: "0.0.0" });
    await client.connect(transport());
    return client;
  }

  it("Client ID Metadata Document のクライアントとしてつなぎ、ツールを使える", async () => {
    const { platform } = setup();
    const provider = new TestProvider(CLIENT_ID);

    const client = await connectWithOAuth(platform, provider);

    expect(provider.clientInformation()?.client_id).toBe(CLIENT_ID);
    const result = (await client.callTool({ name: "list_feeds", arguments: {} })) as {
      structuredContent?: unknown;
    };
    expect(result.structuredContent).toEqual({ feeds: [] });
  });

  it("動的登録したクライアントとしてつなぎ、ツールを使える", async () => {
    const { platform } = setup();
    const provider = new TestProvider();

    const client = await connectWithOAuth(platform, provider);

    expect(provider.clientInformation()?.client_id).toEqual(expect.any(String));
    expect(provider.clientInformation()?.client_id).not.toBe(CLIENT_ID);
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);
  });
});
