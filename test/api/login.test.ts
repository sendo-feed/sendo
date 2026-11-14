import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { safeReturnTo } from "../../src/api/login";
import { createApp } from "../../src/app";
import { GOOGLE } from "../../src/auth/providers";
import { base64UrlEncode, sha256 } from "../../src/lib/crypto";
import type { Platform } from "../../src/platform";
import { createTestPlatform, createUser, fakeFetch } from "../helpers";

const CLIENT = { clientId: "test-client.apps.googleusercontent.com", clientSecret: "test-secret" };
/** ブラウザから見たオリジン（sendo-reader の中継の先） */
const ORIGIN = "https://reader.example.com";
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

type Claims = Record<string, unknown>;

const encodeJson = (value: unknown) =>
  base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));

async function generateKey() {
  return crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  ) as Promise<CryptoKeyPair>;
}

/** 偽の Google。ID トークンに署名する鍵と、トークンのエンドポイントと、公開鍵（JWKS）を持つ */
async function createFakeGoogle() {
  const keys = await generateKey();
  const publicJwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
  /** 認可コード → 返す ID トークン */
  const issued = new Map<string, () => Promise<string>>();
  const tokenRequests: URLSearchParams[] = [];
  let tokenStatus = 200;

  const sign = async (
    claims: Claims,
    options: { key?: CryptoKey; header?: Record<string, unknown> } = {},
  ) => {
    const header = encodeJson({ alg: "RS256", kid: "k1", typ: "JWT", ...options.header });
    const payload = encodeJson(claims);
    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      options.key ?? keys.privateKey,
      new TextEncoder().encode(`${header}.${payload}`),
    );
    return `${header}.${payload}.${base64UrlEncode(new Uint8Array(signature))}`;
  };

  const { fetch, calls } = fakeFetch(async (url, init) => {
    if (url.href === GOOGLE.tokenEndpoint) {
      const body = new URLSearchParams(String(init?.body));
      tokenRequests.push(body);
      const make = issued.get(body.get("code") ?? "");
      if (tokenStatus !== 200 || !make) {
        return Response.json(
          { error: "invalid_grant" },
          { status: tokenStatus === 200 ? 400 : tokenStatus },
        );
      }
      return Response.json({ id_token: await make(), access_token: "x", token_type: "Bearer" });
    }
    if (url.href === GOOGLE.jwksUri) {
      return Response.json({ keys: [{ ...publicJwk, kid: "k1", alg: "RS256", use: "sig" }] });
    }
    return new Response("not found", { status: 404 });
  });

  return {
    fetch,
    calls,
    tokenRequests,
    sign,
    issue: (code: string, make: () => Promise<string>) => issued.set(code, make),
    failTokenEndpoint: (status: number) => {
      tokenStatus = status;
    },
  };
}

type FakeGoogle = Awaited<ReturnType<typeof createFakeGoogle>>;

/** ブラウザのクッキー。応答の Set-Cookie を当て、次のリクエストに付ける */
type Jar = Map<string, { value: string; attributes: string }>;

function applySetCookie(jar: Jar, res: Response) {
  for (const header of res.headers.getSetCookie()) {
    const [pair = "", ...attributes] = header.split(";").map((part) => part.trim());
    const index = pair.indexOf("=");
    const name = pair.slice(0, index);
    const value = pair.slice(index + 1);
    if (/max-age=0/i.test(header) || value === "") jar.delete(name);
    else jar.set(name, { value, attributes: attributes.join("; ") });
  }
}

const cookieHeader = (jar: Jar) =>
  [...jar].map(([name, { value }]) => `${name}=${value}`).join("; ");

/** ブラウザのように、クッキーを付けて送り、応答のクッキーを受け取る */
async function send(
  platform: Platform,
  path: string,
  options: { jar?: Jar; method?: string; headers?: Record<string, string>; body?: unknown } = {},
) {
  const headers = new Headers(options.headers);
  if (options.jar && options.jar.size > 0) headers.set("cookie", cookieHeader(options.jar));
  if (options.body !== undefined) headers.set("content-type", "application/json");
  const res = await createApp(platform).request(`${ORIGIN}${path}`, {
    method: options.method ?? "GET",
    headers,
    ...(options.body !== undefined && { body: JSON.stringify(options.body) }),
  });
  if (options.jar) applySetCookie(options.jar, res);
  return res;
}

function setup(options: { allowed?: string[]; clock?: { now: number } } = {}) {
  const clock = options.clock ?? { now: Date.now() };
  return createFakeGoogle().then((google) => {
    const { platform } = createTestPlatform({
      fetch: google.fetch,
      now: () => new Date(clock.now),
      auth: { allowedEmails: new Set(options.allowed ?? []), google: CLIENT },
    });
    return { platform, google, clock };
  });
}

/**
 * ログインを始め、Google でログインしたことにして戻る。claims で ID トークンの中身を変えられる
 * （関数なら、ログインを始めたときの nonce から作る）
 */
async function login(
  platform: Platform,
  google: FakeGoogle,
  options: {
    sub?: string;
    email?: string;
    claims?: Claims;
    sign?: (claims: Claims) => Promise<string>;
    jar?: Jar;
    returnTo?: string;
    now?: number;
  } = {},
) {
  const jar = options.jar ?? new Map();
  const query =
    options.returnTo === undefined ? "" : `?returnTo=${encodeURIComponent(options.returnTo)}`;
  const start = await send(platform, `/api/v1/auth/google/login${query}`, { jar });
  const location = new URL(start.headers.get("location") ?? "");
  const state = location.searchParams.get("state") ?? "";
  const nonce = location.searchParams.get("nonce") ?? "";
  const iat = Math.floor((options.now ?? Date.now()) / 1000);
  const claims: Claims = {
    iss: "https://accounts.google.com",
    aud: CLIENT.clientId,
    azp: CLIENT.clientId,
    sub: options.sub ?? crypto.randomUUID(),
    email: options.email ?? `${crypto.randomUUID()}@example.com`,
    email_verified: true,
    nonce,
    iat,
    exp: iat + 3600,
    ...options.claims,
  };
  const code = crypto.randomUUID();
  google.issue(code, () => (options.sign ?? google.sign)(claims));
  const callback = await send(
    platform,
    `/api/v1/auth/google/callback?state=${encodeURIComponent(state)}&code=${code}&scope=openid+email`,
    { jar },
  );
  return { start, location, callback, jar, state, code };
}

const loginError = (res: Response) =>
  new URL(res.headers.get("location") ?? "", ORIGIN).searchParams.get("login_error");

async function countUsers(email: string) {
  const row = await env.DB.prepare("SELECT count(*) AS n FROM users WHERE email = ?")
    .bind(email)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

describe("Google でログインする", () => {
  it("Google のログインの画面へ送り、戻ってきたらユーザーを作ってセッションのクッキーを置く", async () => {
    const email = `${crypto.randomUUID()}@example.com`;
    const { platform, google } = await setup({ allowed: [email] });

    const { start, location, callback, jar } = await login(platform, google, {
      email: email.toUpperCase(),
      sub: "google-sub-1",
      returnTo: "/feeds?folder=tech",
    });

    // 1. Google へ（PKCE、state、nonce 付き。戻り先は、ブラウザから見たオリジン）
    expect(start.status).toBe(302);
    expect(`${location.origin}${location.pathname}`).toBe(GOOGLE.authorizationEndpoint);
    const params = Object.fromEntries(location.searchParams);
    expect(params).toMatchObject({
      client_id: CLIENT.clientId,
      redirect_uri: `${ORIGIN}/api/v1/auth/google/callback`,
      response_type: "code",
      scope: "openid email",
      code_challenge_method: "S256",
    });
    expect(params.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(params.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const loginCookie = start.headers
      .getSetCookie()
      .find((c) => c.startsWith("__Host-sendo_login="));
    expect(loginCookie).toMatch(/Max-Age=600/);
    expect(loginCookie).toMatch(/Path=\//);
    expect(loginCookie).toMatch(/Secure/);
    expect(loginCookie).toMatch(/HttpOnly/);
    expect(loginCookie).toMatch(/SameSite=Lax/);

    // 2. 認可コードを ID トークンに替える（同じ戻り先と、PKCE の verifier を送る）
    const exchanged = google.tokenRequests[0];
    expect(exchanged?.get("grant_type")).toBe("authorization_code");
    expect(exchanged?.get("redirect_uri")).toBe(params.redirect_uri);
    expect(exchanged?.get("client_secret")).toBe(CLIENT.clientSecret);
    const verifier = exchanged?.get("code_verifier") ?? "";
    expect(base64UrlEncode(await sha256(verifier))).toBe(params.code_challenge);

    // 3. セッションのクッキーを置いて、始めたときの returnTo へ。ログインのクッキーは消す
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("/feeds?folder=tech");
    expect(jar.has("__Host-sendo_login")).toBe(false);
    const session = jar.get("__Host-sendo_session");
    expect(session?.attributes).toMatch(/HttpOnly/);
    expect(session?.attributes).toMatch(/Secure/);
    expect(session?.attributes).toMatch(/SameSite=Lax/);
    expect(session?.attributes).toMatch(/Path=\//);

    // ユーザーはメールを小文字にそろえて作り、Google の ID を結び付ける
    const me = await send(platform, "/api/v1/me", { jar });
    expect(me.status).toBe(200);
    const body = (await me.json()) as { user: { id: string; email: string } };
    expect(body.user.email).toBe(email);
    const identity = await env.DB.prepare(
      "SELECT user_id, issuer, email FROM identities WHERE subject = ?",
    )
      .bind("google-sub-1")
      .first();
    expect(identity).toEqual({ user_id: body.user.id, issuer: GOOGLE.issuer, email });

    // DB にはクッキーの値を置かない
    const stored = await env.DB.prepare("SELECT token_hash FROM sessions WHERE user_id = ?")
      .bind(body.user.id)
      .first<{ token_hash: string }>();
    expect(stored?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored?.token_hash).not.toBe(session?.value);
  });

  it("許可したメールでなければ、ユーザーを作らずに not_allowed で戻す", async () => {
    const { platform, google } = await setup({ allowed: ["someone-else@example.com"] });
    const email = `${crypto.randomUUID()}@example.com`;

    const { callback, jar } = await login(platform, google, { email });

    expect(loginError(callback)).toBe("not_allowed");
    expect(jar.has("__Host-sendo_session")).toBe(false);
    expect(await countUsers(email)).toBe(0);
  });

  it("確認済みのメールが一致するユーザー（トークンで作った人など）に結び付ける", async () => {
    const existing = await createUser();
    const { platform, google } = await setup({ allowed: [existing.email] });

    const { jar } = await login(platform, google, { email: existing.email });

    const me = (await (await send(platform, "/api/v1/me", { jar })).json()) as {
      user: { id: string };
    };
    expect(me.user.id).toBe(existing.id);
    expect(await countUsers(existing.email)).toBe(1);
  });

  it("結び付いたあとは、Google の側でメールが変わっても同じユーザー（identities のメールは書き換える）", async () => {
    const before = `${crypto.randomUUID()}@example.com`;
    const after = `${crypto.randomUUID()}@example.com`;
    const sub = crypto.randomUUID();
    const { platform, google } = await setup({ allowed: [before] });
    const first = await login(platform, google, { sub, email: before });
    const firstMe = (await (await send(platform, "/api/v1/me", { jar: first.jar })).json()) as {
      user: { id: string };
    };

    const second = await login(platform, google, { sub, email: after });

    const me = (await (await send(platform, "/api/v1/me", { jar: second.jar })).json()) as {
      user: { id: string; email: string };
    };
    expect(me.user).toEqual({ id: firstMe.user.id, email: before });
    expect(await countUsers(after)).toBe(0);
    const identity = await env.DB.prepare("SELECT email FROM identities WHERE subject = ?")
      .bind(sub)
      .first<{ email: string }>();
    expect(identity?.email).toBe(after);
  });

  it("許可から外したメールのユーザーは、結び付いていてもログインできない", async () => {
    const email = `${crypto.randomUUID()}@example.com`;
    const sub = crypto.randomUUID();
    const allowed = await setup({ allowed: [email] });
    await login(allowed.platform, allowed.google, { sub, email });

    const removed = await setup({ allowed: [] });
    const { callback, jar } = await login(removed.platform, removed.google, { sub, email });

    expect(loginError(callback)).toBe("not_allowed");
    expect(jar.has("__Host-sendo_session")).toBe(false);
  });

  it("同じ人が同時に初めてログインしても、ユーザーと結び付きは 1 つ", async () => {
    const email = `${crypto.randomUUID()}@example.com`;
    const sub = crypto.randomUUID();
    const { platform, google } = await setup({ allowed: [email] });

    const results = await Promise.all([
      login(platform, google, { sub, email }),
      login(platform, google, { sub, email }),
    ]);

    const ids = await Promise.all(
      results.map(async ({ jar }) => {
        const me = (await (await send(platform, "/api/v1/me", { jar })).json()) as {
          user: { id: string };
        };
        return me.user.id;
      }),
    );
    expect(ids[0]).toBe(ids[1]);
    expect(await countUsers(email)).toBe(1);
    const links = await env.DB.prepare("SELECT count(*) AS n FROM identities WHERE subject = ?")
      .bind(sub)
      .first<{ n: number }>();
    expect(links?.n).toBe(1);
  });

  it("ほかのブラウザで始めたログイン（クッキーがない ／ state が違う）は、invalid_request で戻す", async () => {
    const email = `${crypto.randomUUID()}@example.com`;
    const { platform, google } = await setup({ allowed: [email] });

    // 攻撃者が自分のブラウザで始め、戻り先の URL を被害者に踏ませる
    const attacker = new Map() as Jar;
    const start = await send(platform, "/api/v1/auth/google/login", { jar: attacker });
    const state = new URL(start.headers.get("location") ?? "").searchParams.get("state");
    google.issue("stolen", () => google.sign({}));
    const victim = new Map() as Jar;
    const replayed = await send(
      platform,
      `/api/v1/auth/google/callback?state=${state}&code=stolen`,
      { jar: victim },
    );
    expect(loginError(replayed)).toBe("invalid_request");
    expect(victim.has("__Host-sendo_session")).toBe(false);

    // 自分のブラウザで始めていても、state が違えば受けない
    const mine = new Map() as Jar;
    await send(platform, "/api/v1/auth/google/login", { jar: mine });
    const mismatched = await send(
      platform,
      `/api/v1/auth/google/callback?state=${state}&code=stolen`,
      { jar: mine },
    );
    expect(loginError(mismatched)).toBe("invalid_request");
    expect(mine.has("__Host-sendo_login")).toBe(false);
    // 認可コードを ID トークンに替えるところまで進まない
    expect(google.tokenRequests).toHaveLength(0);
  });

  it("ID トークンの署名や中身が正しくなければ、ログインさせない", async () => {
    const email = `${crypto.randomUUID()}@example.com`;
    const { platform, google } = await setup({ allowed: [email] });
    const otherKey = (await generateKey()).privateKey;
    const now = Math.floor(Date.now() / 1000);

    const cases: { name: string; claims?: Claims; sign?: (claims: Claims) => Promise<string> }[] = [
      { name: "ほかの鍵で署名", sign: (claims) => google.sign(claims, { key: otherKey }) },
      {
        name: "署名なし（alg が none）",
        sign: async (claims) => `${encodeJson({ alg: "none" })}.${encodeJson(claims)}.`,
      },
      {
        name: "知らない鍵の ID",
        sign: (claims) => google.sign(claims, { header: { kid: "unknown" } }),
      },
      { name: "ほかのクライアント向け", claims: { aud: "other-client", azp: "other-client" } },
      { name: "ほかの提供元", claims: { iss: "https://evil.example.com" } },
      { name: "期限切れ", claims: { iat: now - 7200, exp: now - 3600 } },
      { name: "nonce が違う（使い回し）", claims: { nonce: "replayed" } },
      {
        name: "中身を書き換えた",
        sign: async (claims) => {
          const [header, , signature] = (await google.sign(claims)).split(".");
          return `${header}.${encodeJson({ ...claims, email: "admin@example.com" })}.${signature}`;
        },
      },
    ];
    for (const { name, claims, sign } of cases) {
      const { callback, jar } = await login(platform, google, {
        email,
        ...(claims && { claims }),
        ...(sign && { sign }),
      });
      expect(loginError(callback), name).toBe("invalid_id_token");
      expect(jar.has("__Host-sendo_session"), name).toBe(false);
    }
    expect(await countUsers(email)).toBe(0);
  });

  it("Google がメールを確認済みとしていなければ、email_not_verified で戻す", async () => {
    const email = `${crypto.randomUUID()}@example.com`;
    const { platform, google } = await setup({ allowed: [email] });

    const { callback } = await login(platform, google, {
      email,
      claims: { email_verified: false },
    });

    expect(loginError(callback)).toBe("email_not_verified");
    expect(await countUsers(email)).toBe(0);
  });

  it("Google の画面でやめた ／ Google がエラーを返したら、理由を付けて戻す", async () => {
    const { platform, google } = await setup();
    const jar = new Map() as Jar;
    await send(platform, "/api/v1/auth/google/login", { jar });
    const cancelled = await send(platform, "/api/v1/auth/google/callback?error=access_denied", {
      jar,
    });
    expect(cancelled.status).toBe(302);
    expect(loginError(cancelled)).toBe("access_denied");

    google.failTokenEndpoint(500);
    const { callback } = await login(platform, google);
    expect(loginError(callback)).toBe("provider_error");
  });

  it("Google を設定していなければ、ログインを始めない（404）", async () => {
    const { platform } = createTestPlatform();

    const res = await send(platform, "/api/v1/auth/google/login");

    expect(res.status).toBe(404);
  });
});

describe("ログインのあとに戻る先", () => {
  it("同じオリジンのパスだけを受け、ほかのサイトへは飛ばさない", () => {
    expect(safeReturnTo(undefined)).toBe("/");
    expect(safeReturnTo("/feeds?folder=tech#top")).toBe("/feeds?folder=tech#top");
    for (const value of [
      "https://evil.example.com/",
      "//evil.example.com/",
      "/\\evil.example.com/",
      "evil",
      "javascript:alert(1)",
      "/\nLocation: https://evil.example.com",
    ]) {
      expect(safeReturnTo(value), value).toBe("/");
    }
  });
});

describe("セッション", () => {
  async function loggedIn(clock = { now: Date.now() }) {
    const email = `${crypto.randomUUID()}@example.com`;
    const context = await setup({ allowed: [email], clock });
    const { jar } = await login(context.platform, context.google, { email, now: clock.now });
    return { ...context, jar };
  }

  it("セッションのクッキーで API を使える（Bearer は要らない）", async () => {
    const { platform, jar } = await loggedIn();

    expect((await send(platform, "/api/v1/feeds", { jar })).status).toBe(200);
    expect((await send(platform, "/api/v1/feeds")).status).toBe(401);
  });

  it("クッキーで認証した、状態を変えるリクエストは、同じオリジンのページからだけ受ける", async () => {
    const { platform, jar } = await loggedIn();
    const create = (headers: Record<string, string>) =>
      send(platform, "/api/v1/folders", {
        jar,
        method: "POST",
        headers,
        body: { name: crypto.randomUUID() },
      });

    expect((await create({ "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await create({ "sec-fetch-site": "same-site" })).status).toBe(403);
    expect((await create({ origin: "https://evil.example.com" })).status).toBe(403);
    expect((await create({})).status).toBe(403);
    expect((await create({ "sec-fetch-site": "same-origin" })).status).toBe(201);
    // Sec-Fetch-Site を付けないブラウザでは、Origin が同じなら受ける
    expect((await create({ origin: ORIGIN })).status).toBe(201);
    // 読むだけのリクエストは、ほかのサイトからでも受ける（応答は、ほかのサイトからは読めない）
    expect(
      (
        await send(platform, "/api/v1/folders", {
          jar,
          headers: { "sec-fetch-site": "cross-site" },
        })
      ).status,
    ).toBe(200);
  });

  it("Authorization を付けたら、クッキーは見ない", async () => {
    const { platform, jar } = await loggedIn();

    const res = await send(platform, "/api/v1/me", {
      jar,
      headers: { authorization: "Bearer sendo_wrong" },
    });

    expect(res.status).toBe(401);
  });

  it("ログアウトすると、そのセッションは使えなくなる。ほかのサイトからはログアウトさせられない", async () => {
    const { platform, jar } = await loggedIn();
    const cookie = cookieHeader(jar);

    const crossSite = await send(platform, "/api/v1/auth/logout", {
      jar,
      method: "POST",
      headers: { "sec-fetch-site": "cross-site" },
    });
    expect(crossSite.status).toBe(403);
    expect((await send(platform, "/api/v1/me", { jar })).status).toBe(200);

    const res = await send(platform, "/api/v1/auth/logout", {
      jar,
      method: "POST",
      headers: { "sec-fetch-site": "same-origin" },
    });
    expect(res.status).toBe(204);
    expect(jar.has("__Host-sendo_session")).toBe(false);
    // 消したクッキーを送り直しても使えない
    const reused = await send(platform, "/api/v1/me", { headers: { cookie } });
    expect(reused.status).toBe(401);
  });

  it("ログインし直すと、前のセッションは消える", async () => {
    const { platform, google, jar } = await loggedIn();
    const previous = cookieHeader(jar);
    const email = (
      (await (await send(platform, "/api/v1/me", { jar })).json()) as {
        user: { email: string };
      }
    ).user.email;

    await login(platform, google, { email, jar });

    expect((await send(platform, "/api/v1/me", { headers: { cookie: previous } })).status).toBe(
      401,
    );
    expect((await send(platform, "/api/v1/me", { jar })).status).toBe(200);
  });

  it("使っていれば期限が延び、30 日使わなければ使えなくなる（クッキーも消す）", async () => {
    const clock = { now: Date.now() };
    const { platform, jar } = await loggedIn(clock);

    // 29 日後に使うと、そこから 30 日に延びる（クッキーの期限も延ばす）
    clock.now += 29 * DAY;
    const renewed = await send(platform, "/api/v1/me", { jar });
    expect(renewed.status).toBe(200);
    expect(renewed.headers.getSetCookie().join()).toMatch(/__Host-sendo_session=.*Max-Age=2592000/);

    // 初めから 31 日たっても、延びているので使える
    clock.now += 2 * DAY;
    expect((await send(platform, "/api/v1/me", { jar })).status).toBe(200);

    // そこから 30 日使わなければ使えない
    clock.now += 30 * DAY + HOUR;
    const expired = await send(platform, "/api/v1/me", { jar });
    expect(expired.status).toBe(401);
    expect(jar.has("__Host-sendo_session")).toBe(false);
  });
});
