/**
 * 偽の Google と、ブラウザのようにクッキーを持ち回る送り方（docs/decisions/accounts.md の 2、6）。
 * ログインとログアウトを本番の入口（/api/v1/auth/...）から通すテストで使う。
 */
import type { webcrypto } from "node:crypto";
import { createApp } from "../src/app";
import { GOOGLE } from "../src/auth/providers";
import { base64UrlEncode } from "../src/lib/crypto";
import type { Platform } from "../src/platform";
import { fakeFetch } from "./helpers";

export const GOOGLE_CLIENT = {
  clientId: "test-client.apps.googleusercontent.com",
  clientSecret: "test-secret",
};
/** ブラウザから見たオリジン（sendo-reader の中継の先） */
export const ORIGIN = "https://reader.example.com";

export type Claims = Record<string, unknown>;

export const encodeJson = (value: unknown) =>
  base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));

export async function generateKey() {
  return crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  ) as Promise<webcrypto.CryptoKeyPair>;
}

/** 偽の Google。ID トークンに署名する鍵と、トークンのエンドポイントと、公開鍵（JWKS）を持つ */
export async function createFakeGoogle() {
  const keys = await generateKey();
  const publicJwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
  /** 認可コード → 返す ID トークン */
  const issued = new Map<string, () => Promise<string>>();
  const tokenRequests: URLSearchParams[] = [];
  let tokenStatus = 200;

  const sign = async (
    claims: Claims,
    options: { key?: webcrypto.CryptoKey; header?: Record<string, unknown> } = {},
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

export type FakeGoogle = Awaited<ReturnType<typeof createFakeGoogle>>;

/** ブラウザのクッキー。応答の Set-Cookie を当て、次のリクエストに付ける */
export type Jar = Map<string, { value: string; attributes: string }>;

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

export const cookieHeader = (jar: Jar) =>
  [...jar].map(([name, { value }]) => `${name}=${value}`).join("; ");

/** ブラウザのように、クッキーを付けて送り、応答のクッキーを受け取る */
export async function send(
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

/**
 * ログインを始め、Google でログインしたことにして戻る。claims で ID トークンの中身を変えられる
 * （関数なら、ログインを始めたときの nonce から作る）
 */
export async function login(
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
    aud: GOOGLE_CLIENT.clientId,
    azp: GOOGLE_CLIENT.clientId,
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
