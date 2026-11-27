import type { Database } from "../db";
import { getOrCreateSecret, VAPID_KEY } from "../db/secrets";
import { base64UrlEncode } from "../lib/crypto";

/*
 * VAPID の鍵の組（docs/decisions/web-push.md の 1）。sendo が初めて要るときに作り、秘密の JWK
 * （公開鍵の x・y を含む）を app_secrets の 1 行に置く。自動では作り直さない。ブラウザの登録は公開鍵に
 * 結び付くので、作り直すと登録がすべて使えなくなる。
 */

const ES256 = { name: "ECDSA", namedCurve: "P-256" } as const;

/** P-256 の鍵の組を作り、秘密の JWK の JSON にする */
async function createVapidKey(): Promise<string> {
  const pair = await crypto.subtle.generateKey(ES256, true, ["sign", "verify"]);
  return JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey));
}

/**
 * VAPID の公開鍵。非圧縮の点（65 バイト）の base64url で、ブラウザの PushManager.subscribe の
 * applicationServerKey にそのまま渡せる。鍵がなければ作る
 */
export async function getVapidPublicKey(db: Database): Promise<string> {
  const { x, y } = JSON.parse(await getOrCreateSecret(db, VAPID_KEY, createVapidKey)) as {
    x: string;
    y: string;
  };
  const publicKey = await crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", x, y },
    ES256,
    true,
    ["verify"],
  );
  return base64UrlEncode(new Uint8Array(await crypto.subtle.exportKey("raw", publicKey)));
}
