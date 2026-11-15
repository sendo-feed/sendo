import { base64UrlDecode, base64UrlEncode } from "./crypto";

/*
 * 画像の中継の URL と、その署名（docs/decisions/images.md の 1、2）。
 *
 * sendo が中継するのは、自分で署名した URL だけ。署名は、もとの URL の HMAC-SHA-256 の先頭
 * 128 ビット。ユーザーと期限は入れない（認証は別に求める）。Web Crypto だけを使う。
 */

/** 中継の入口のパス。クライアントには、このパスに url と sig を付けたものをそのまま配る */
export const IMAGE_PATH = "/api/v1/images";

/** 署名の長さ（バイト）。HMAC-SHA-256 の先頭を使う */
const SIGNATURE_BYTES = 16;

/** もとの URL から、中継を通る URL を作る ／ 署名を確かめる */
export type ImageSigner = {
  /** 中継を通る URL（オリジンを付けないパス）。もとの URL が null なら null */
  toRelayUrl(url: string | null): Promise<string | null>;
  /** 署名が、その URL に sendo が付けたものか */
  verify(url: string, signature: string): Promise<boolean>;
};

/** 鍵（乱数を base64url にしたもの）から、署名の道具を作る */
export async function createImageSigner(secret: string): Promise<ImageSigner> {
  const raw = base64UrlDecode(secret);
  if (raw === undefined || raw.byteLength < 32) throw new Error("image signing key is malformed");
  const key = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);

  const sign = async (url: string): Promise<Uint8Array> => {
    const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(url));
    return new Uint8Array(mac, 0, SIGNATURE_BYTES);
  };

  return {
    async toRelayUrl(url) {
      if (url === null) return null;
      const signature = base64UrlEncode(await sign(url));
      return `${IMAGE_PATH}?url=${encodeURIComponent(url)}&sig=${signature}`;
    },
    async verify(url, signature) {
      const given = base64UrlDecode(signature);
      if (given === undefined || given.byteLength !== SIGNATURE_BYTES) return false;
      const expected = await sign(url);
      // 途中でやめずに最後まで比べる（かかった時間から、合っていた長さが分からないように）
      let diff = 0;
      for (let i = 0; i < SIGNATURE_BYTES; i++) diff |= (expected[i] ?? 0) ^ (given[i] ?? 0);
      return diff === 0;
    },
  };
}
