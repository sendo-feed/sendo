import { base64UrlDecode, type WebCryptoKey } from "../lib/crypto";

/*
 * Web Push の本体の暗号化（RFC 8291。docs/decisions/notifications.md の 16）。中身は RFC 8188 の
 * aes128gcm の 1 つのレコードにする。Web Crypto だけで書く。
 */

/** プッシュサービスが受ける、暗号化した本体の上限 */
export const MAX_ENCRYPTED_BYTES = 4096;

/** 見出し（salt 16、レコードの大きさ 4、鍵の長さ 1、送り手の公開鍵 65） */
const HEADER_BYTES = 86;

/** レコードの区切り（0x02）1 バイトと、認証タグ 16 バイト */
const RECORD_OVERHEAD_BYTES = 17;

/** 暗号化の前の中身の上限（4096 − 86 − 1 − 16 = 3993） */
export const MAX_PUSH_PAYLOAD_BYTES = MAX_ENCRYPTED_BYTES - HEADER_BYTES - RECORD_OVERHEAD_BYTES;

/** 見出しに書くレコードの大きさ（RFC 8188 の rs）。1 つのレコードに中身がすべて入る */
const RECORD_SIZE = 4096;

const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;
const encoder = new TextEncoder();

/**
 * 端末の鍵（登録の p256dh と auth。base64url）で、中身を暗号化した本体にする。送り手の鍵の組と
 * salt は、送るたびに作る
 */
export async function encryptPushMessage(
  plaintext: Uint8Array,
  keys: { p256dh: string; auth: string },
): Promise<Uint8Array> {
  const receiverPublicKey = base64UrlDecode(keys.p256dh);
  const authSecret = base64UrlDecode(keys.auth);
  if (receiverPublicKey === undefined || authSecret === undefined) {
    throw new Error("push registration keys are not base64url");
  }
  return encryptPushRecord({
    plaintext,
    receiverPublicKey,
    authSecret,
    senderKeys: await crypto.subtle.generateKey(ECDH, false, ["deriveBits"]),
    salt: crypto.getRandomValues(new Uint8Array(16)),
  });
}

/**
 * 決まった送り手の鍵の組と salt で暗号化する（RFC 8291 の 3、RFC 8188 の 2）。本体は、見出しと
 * 1 つのレコード（中身、区切りの 0x02、認証タグ）
 */
export async function encryptPushRecord(input: {
  plaintext: Uint8Array;
  /** 端末の公開鍵（P-256 の非圧縮の点 65 バイト） */
  receiverPublicKey: Uint8Array;
  /** 端末の認証の秘密（16 バイト） */
  authSecret: Uint8Array;
  /** 送り手の ECDH の鍵の組 */
  senderKeys: { privateKey: WebCryptoKey; publicKey: WebCryptoKey };
  /** 16 バイトの乱数 */
  salt: Uint8Array;
}): Promise<Uint8Array> {
  const { plaintext, receiverPublicKey, authSecret, senderKeys, salt } = input;
  if (plaintext.length > MAX_PUSH_PAYLOAD_BYTES) {
    throw new RangeError(`push payload exceeds ${MAX_PUSH_PAYLOAD_BYTES} bytes`);
  }
  const senderPublicKey = new Uint8Array(
    await crypto.subtle.exportKey("raw", senderKeys.publicKey),
  );
  const receiver = await crypto.subtle.importKey("raw", receiverPublicKey, ECDH, false, []);
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: receiver }, senderKeys.privateKey, 256),
  );
  // 端末の秘密と ECDH の結果を合わせてから、レコードの鍵と nonce を作る（RFC 8291 の 3.4）
  const ikm = await hkdf({
    salt: authSecret,
    ikm: ecdhSecret,
    info: concat(encoder.encode("WebPush: info\0"), receiverPublicKey, senderPublicKey),
    bytes: 32,
  });
  const cek = await hkdf({
    salt,
    ikm,
    info: encoder.encode("Content-Encoding: aes128gcm\0"),
    bytes: 16,
  });
  const nonce = await hkdf({
    salt,
    ikm,
    info: encoder.encode("Content-Encoding: nonce\0"),
    bytes: 12,
  });
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  // 最後の（ただ 1 つの）レコードなので、区切りは 0x02。詰め物は足さない
  const record = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce },
      key,
      concat(plaintext, Uint8Array.of(0x02)),
    ),
  );

  const header = new Uint8Array(HEADER_BYTES);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = senderPublicKey.length;
  header.set(senderPublicKey, 21);
  return concat(header, record);
}

async function hkdf(input: {
  salt: Uint8Array;
  ikm: Uint8Array;
  info: Uint8Array;
  bytes: number;
}): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", input.ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: input.salt, info: input.info },
      key,
      input.bytes * 8,
    ),
  );
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}
