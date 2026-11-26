/**
 * 偽の端末とプッシュサービス（docs/decisions/notifications.md の 16、18、21）。端末は本物の P-256 の
 * 鍵の組と auth を持ち、受けた本体を自分の秘密鍵で復号する（RFC 8291 の受け手の側）。プッシュ
 * サービスは、VAPID の JWT を確かめてから、本体を端末に渡す。
 */
import type { webcrypto } from "node:crypto";
import { base64UrlDecode, base64UrlEncode } from "../src/lib/crypto";

const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;
const encoder = new TextEncoder();

export type Device = {
  privateKey: webcrypto.CryptoKey;
  /** 非圧縮の点（65 バイト） */
  publicKey: Uint8Array;
  authSecret: Uint8Array;
  /** 登録で送る鍵（PushSubscription.toJSON() の keys と同じ形） */
  keys: { p256dh: string; auth: string };
};

/** 端末の鍵を作る */
export async function createDevice(): Promise<Device> {
  const pair = (await crypto.subtle.generateKey(ECDH, true, [
    "deriveBits",
  ])) as webcrypto.CryptoKeyPair;
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const authSecret = crypto.getRandomValues(new Uint8Array(16));
  return deviceOf(pair.privateKey, publicKey, authSecret);
}

export function deviceOf(
  privateKey: webcrypto.CryptoKey,
  publicKey: Uint8Array,
  authSecret: Uint8Array,
): Device {
  return {
    privateKey,
    publicKey,
    authSecret,
    keys: { p256dh: base64UrlEncode(publicKey), auth: base64UrlEncode(authSecret) },
  };
}

/** P-256 の非圧縮の点と秘密の値（d）を、Web Crypto で読める JWK にする */
export function p256Jwk(publicKey: Uint8Array, d?: string): webcrypto.JsonWebKey {
  return {
    kty: "EC",
    crv: "P-256",
    x: base64UrlEncode(publicKey.slice(1, 33)),
    y: base64UrlEncode(publicKey.slice(33, 65)),
    ...(d !== undefined && { d }),
  };
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8),
  );
}

const join = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

/**
 * aes128gcm の本体を、端末の秘密鍵で復号する（RFC 8291 の 3.4、RFC 8188 の 2）。レコードは 1 つで、
 * 最後の区切り（0x02）と詰め物を除いて返す。形が合わなければ例外
 */
export async function decryptPushMessage(body: Uint8Array, device: Device): Promise<Uint8Array> {
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const salt = body.slice(0, 16);
  const recordSize = view.getUint32(16);
  const keyLength = body[20] ?? 0;
  const senderPublicKey = body.slice(21, 21 + keyLength);
  const record = body.slice(21 + keyLength);
  if (keyLength !== 65 || record.length > recordSize) throw new Error("not a single record");

  const sender = await crypto.subtle.importKey("raw", senderPublicKey, ECDH, false, []);
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: sender }, device.privateKey, 256),
  );
  const ikm = await hkdf(
    device.authSecret,
    ecdhSecret,
    join(encoder.encode("WebPush: info\0"), device.publicKey, senderPublicKey),
    32,
  );
  const cek = await hkdf(salt, ikm, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, encoder.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const padded = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, record),
  );
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end--;
  if (padded[end] !== 0x02) throw new Error("the last record must end with 0x02");
  return padded.slice(0, end);
}

/** VAPID の JWT の中身（RFC 8292 の 2） */
export type VapidClaims = { aud: string; exp: number; sub: string };

/**
 * Authorization の `vapid t=<JWT>, k=<公開鍵>` を読み、JWT の署名を k の公開鍵で確かめる。
 * 形が合わないか、署名が合わなければ例外
 */
export async function verifyVapid(
  authorization: string | null,
): Promise<{ token: string; publicKey: string; header: unknown; claims: VapidClaims }> {
  const match = /^vapid t=([^,\s]+), k=([A-Za-z0-9_-]+)$/.exec(authorization ?? "");
  if (!match?.[1] || !match[2]) throw new Error(`not a VAPID authorization: ${authorization}`);
  const [token, publicKey] = [match[1], match[2]];
  const [header, payload, signature] = token.split(".");
  const point = base64UrlDecode(publicKey);
  const signatureBytes = base64UrlDecode(signature ?? "");
  if (!header || !payload || !point || !signatureBytes) throw new Error("malformed JWT");
  const key = await crypto.subtle.importKey(
    "raw",
    point,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    signatureBytes,
    encoder.encode(`${header}.${payload}`),
  );
  if (!valid) throw new Error("VAPID signature does not verify");
  const decode = (part: string) =>
    JSON.parse(new TextDecoder().decode(base64UrlDecode(part))) as unknown;
  return { token, publicKey, header: decode(header), claims: decode(payload) as VapidClaims };
}
