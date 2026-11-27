import type { PushRegistrationKeys } from "../db/push-registrations";
import { toFetchableUrl, UrlNotAllowedError } from "../fetcher/url-guard";
import { base64UrlDecode, base64UrlEncode } from "../lib/crypto";

/*
 * ブラウザが返した Web Push の登録を確かめる（docs/decisions/web-push.md の 4、6）。
 * 壊れた鍵は、送るときの暗号化で失敗し、通知のたびに仕事が無駄になるので、受けるときに断る。
 */

/** エンドポイントの長さの上限 */
export const MAX_ENDPOINT_LENGTH = 2048;

/** P-256 の非圧縮の点の長さ（0x04、x の 32 バイト、y の 32 バイト） */
const P256_POINT_BYTES = 65;

/** auth の秘密の長さ（RFC 8291） */
const AUTH_SECRET_BYTES = 16;

export type PushRegistrationInput = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
};

/**
 * 登録を確かめ、置く形にする（エンドポイントは正規化した URL、鍵はパディングのない base64url）。
 * 合わなければ、どの項目が合わないかを返す（値はエラーに入れない。秘密として扱う）
 */
export async function parsePushRegistration(
  input: PushRegistrationInput,
): Promise<PushRegistrationKeys | { invalid: "endpoint" | "keys.p256dh" | "keys.auth" }> {
  const endpoint = parseEndpoint(input.endpoint);
  if (endpoint === undefined) return { invalid: "endpoint" };
  const p256dh = await parseP256dh(input.keys.p256dh);
  if (p256dh === undefined) return { invalid: "keys.p256dh" };
  const auth = base64UrlDecode(input.keys.auth);
  if (auth?.length !== AUTH_SECRET_BYTES) return { invalid: "keys.auth" };
  return { endpoint, p256dh, auth: base64UrlEncode(auth) };
}

/** https: だけ。フィードの取得と同じく、内部の宛先などを toFetchableUrl で断る */
function parseEndpoint(text: string): string | undefined {
  let url: URL;
  try {
    url = toFetchableUrl(text);
  } catch (error) {
    if (error instanceof UrlNotAllowedError) return undefined;
    throw error;
  }
  if (url.protocol !== "https:" || url.href.length > MAX_ENDPOINT_LENGTH) return undefined;
  return url.href;
}

/**
 * 非圧縮の点で、Web Crypto で P-256 の公開鍵として読めるもの。Web Crypto は圧縮した点（33 バイト）や
 * hybrid の点（0x06、0x07）も読むので、長さと先頭のバイトも見る
 */
async function parseP256dh(text: string): Promise<string | undefined> {
  const point = base64UrlDecode(text);
  if (point?.length !== P256_POINT_BYTES || point[0] !== 0x04) return undefined;
  try {
    await crypto.subtle.importKey("raw", point, { name: "ECDH", namedCurve: "P-256" }, false, []);
  } catch {
    return undefined;
  }
  return base64UrlEncode(point);
}
