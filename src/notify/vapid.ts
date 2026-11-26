import type { Database } from "../db";
import { getOrCreateSecret, VAPID_KEY } from "../db/secrets";
import { base64UrlEncode, type WebCryptoKey } from "../lib/crypto";

/*
 * VAPID（RFC 8292。docs/decisions/notifications.md の 17、18）。
 *
 * 鍵の組は、sendo が初めて要るときに作り、秘密の JWK（公開鍵の x・y を含む）を app_secrets の 1 行に
 * 置く。自動では作り直さない。ブラウザの登録は公開鍵に結び付くので、作り直すと登録がすべて使えなく
 * なる。
 *
 * JWT は送り先のオリジン（aud）ごとに作り、プロセスのメモリに持って、作ってから 6 時間は使い回す。
 */

const ES256 = { name: "ECDSA", namedCurve: "P-256" } as const;

/** 同じ aud に JWT を使い回す長さ（Apple に合わせて 1 時間以上） */
export const VAPID_TOKEN_REUSE_MS = 6 * 60 * 60 * 1000;

/** JWT の exp を、作った時刻からどれだけ先にするか（RFC 8292 は 24 時間未満を求める） */
export const VAPID_TOKEN_LIFETIME_MS = 12 * 60 * 60 * 1000;

/** メモリに持つ JWT の数の上限。超えたら捨てて作り直す（送り先のオリジンは、ふつう数個） */
const MAX_CACHED_TOKENS = 1000;

type VapidKey = { privateKey: WebCryptoKey; publicKey: string };
type VapidToken = { value: string; createdAt: number };

/**
 * 送り手の識別（公開鍵、sub、aud）ごとの JWT。作っている途中のものも入れ、同じ aud の JWT を同時に
 * 何個も作らない
 */
const tokens = new Map<string, Promise<VapidToken>>();

/** P-256 の鍵の組を作り、秘密の JWK の JSON にする */
async function createVapidKey(): Promise<string> {
  const pair = await crypto.subtle.generateKey(ES256, true, ["sign", "verify"]);
  return JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey));
}

/** 鍵の組を読む。なければ作る */
async function loadVapidKey(db: Database): Promise<VapidKey> {
  const secret = await getOrCreateSecret(db, VAPID_KEY, createVapidKey);
  const { x, y } = JSON.parse(secret) as { x: string; y: string };
  const publicKey = await crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", x, y },
    ES256,
    true,
    ["verify"],
  );
  return {
    privateKey: await crypto.subtle.importKey("jwk", JSON.parse(secret), ES256, false, ["sign"]),
    publicKey: base64UrlEncode(new Uint8Array(await crypto.subtle.exportKey("raw", publicKey))),
  };
}

/**
 * VAPID の公開鍵。非圧縮の点（65 バイト）の base64url で、ブラウザの PushManager.subscribe の
 * applicationServerKey にそのまま渡せる。鍵がなければ作る
 */
export async function getVapidPublicKey(db: Database): Promise<string> {
  return (await loadVapidKey(db)).publicKey;
}

/**
 * エンドポイントへ送る要求の Authorization（`vapid t=<JWT>, k=<公開鍵>`。RFC 8292 の 3）。
 * JWT は ES256 で、aud はエンドポイントのオリジン、exp は作った時刻の 12 時間後
 */
export async function vapidAuthorization(
  db: Database,
  input: { subject: string; endpoint: string; now: Date },
): Promise<string> {
  const key = await loadVapidKey(db);
  const aud = new URL(input.endpoint).origin;
  const createdAt = input.now.getTime();
  const token = await reuseToken(`${key.publicKey} ${input.subject} ${aud}`, createdAt, () =>
    signToken(key.privateKey, { aud, sub: input.subject, createdAt }),
  );
  return `vapid t=${token}, k=${key.publicKey}`;
}

/**
 * 作ってから 6 時間たっていない JWT があれば、それを使う。作っている途中なら、それを待って使う。
 * 古いか、作るのに失敗していたら、作り直す（時計が戻って、作った時刻より前になったときも）
 */
async function reuseToken(
  id: string,
  now: number,
  sign: () => Promise<VapidToken>,
): Promise<string> {
  for (;;) {
    const cached = tokens.get(id);
    if (cached === undefined) break;
    const token = await cached.catch(() => undefined);
    if (token && token.createdAt <= now && now - token.createdAt < VAPID_TOKEN_REUSE_MS) {
      return token.value;
    }
    // 待っている間に、ほかの送信が作り直し始めていたら、そちらを待つ
    if (tokens.get(id) === cached) {
      tokens.delete(id);
      break;
    }
  }
  if (tokens.size >= MAX_CACHED_TOKENS) tokens.clear();
  const created = sign();
  tokens.set(id, created);
  try {
    return (await created).value;
  } catch (error) {
    if (tokens.get(id) === created) tokens.delete(id);
    throw error;
  }
}

async function signToken(
  privateKey: WebCryptoKey,
  input: { aud: string; sub: string; createdAt: number },
): Promise<VapidToken> {
  const encode = (value: unknown) =>
    base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
  const signingInput = `${encode({ typ: "JWT", alg: "ES256" })}.${encode({
    aud: input.aud,
    exp: Math.floor((input.createdAt + VAPID_TOKEN_LIFETIME_MS) / 1000),
    sub: input.sub,
  })}`;
  // Web Crypto の ECDSA の署名は r と s を並べた 64 バイトで、JWS の ES256 の形と同じ
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(signingInput),
  );
  return {
    value: `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`,
    createdAt: input.createdAt,
  };
}
