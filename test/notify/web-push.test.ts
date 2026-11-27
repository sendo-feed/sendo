import type { webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import { base64UrlDecode, base64UrlEncode } from "../../src/lib/crypto";
import {
  encryptPushMessage,
  encryptPushRecord,
  MAX_ENCRYPTED_BYTES,
  MAX_PUSH_PAYLOAD_BYTES,
} from "../../src/notify/web-push";
import { createDevice, decryptPushMessage, deviceOf, p256Jwk } from "../push-service";

/** RFC 8291 の 5 と付録 A の例 */
const RFC = {
  plaintext: "When I grow up, I want to be a watermelon",
  authSecret: "BTBZMqHH6r4Tts7J_aSIgg",
  receiverPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  receiverPublic:
    "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  senderPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  senderPublic:
    "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  body:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml" +
    "mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT" +
    "pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

const bytes = (text: string) => {
  const decoded = base64UrlDecode(text);
  if (!decoded) throw new Error(`not base64url: ${text}`);
  return decoded;
};

const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;

/** 例の鍵の組を、Web Crypto で読む */
async function importPair(publicKey: string, privateKey: string) {
  const point = bytes(publicKey);
  return {
    point,
    privateKey: (await crypto.subtle.importKey("jwk", p256Jwk(point, privateKey), ECDH, false, [
      "deriveBits",
    ])) as webcrypto.CryptoKey,
    publicKey: (await crypto.subtle.importKey("raw", point, ECDH, true, [])) as webcrypto.CryptoKey,
  };
}

describe("Web Push の暗号化（RFC 8291）", () => {
  it("RFC 8291 の付録 A の例と、同じ本体になる", async () => {
    const sender = await importPair(RFC.senderPublic, RFC.senderPrivate);

    const body = await encryptPushRecord({
      plaintext: new TextEncoder().encode(RFC.plaintext),
      receiverPublicKey: bytes(RFC.receiverPublic),
      authSecret: bytes(RFC.authSecret),
      senderKeys: { privateKey: sender.privateKey, publicKey: sender.publicKey },
      salt: bytes(RFC.salt),
    });

    expect(base64UrlEncode(body)).toBe(RFC.body);
  });

  it("テストの端末の復号は、RFC 8291 の例を元の文に戻す", async () => {
    const receiver = await importPair(RFC.receiverPublic, RFC.receiverPrivate);
    const device = deviceOf(receiver.privateKey, receiver.point, bytes(RFC.authSecret));

    const plaintext = await decryptPushMessage(bytes(RFC.body), device);

    expect(new TextDecoder().decode(plaintext)).toBe(RFC.plaintext);
  });

  it("登録の鍵で暗号化した本体を、端末が復号できる。送るたびに salt と送り手の鍵が変わる", async () => {
    const device = await createDevice();
    const plaintext = new TextEncoder().encode('{"web_push":8030}');

    const first = await encryptPushMessage(plaintext, device.keys);
    const second = await encryptPushMessage(plaintext, device.keys);

    expect(await decryptPushMessage(first, device)).toEqual(plaintext);
    expect(await decryptPushMessage(second, device)).toEqual(plaintext);
    expect(first.slice(0, 16)).not.toEqual(second.slice(0, 16));
    expect(first.slice(21, 86)).not.toEqual(second.slice(21, 86));
  });

  it("中身が 3993 バイトちょうどなら、暗号化した本体は 4096 バイトちょうど。1 バイト超えると断る", async () => {
    const device = await createDevice();
    expect(MAX_PUSH_PAYLOAD_BYTES).toBe(3993);

    const body = await encryptPushMessage(new Uint8Array(3993).fill(0x61), device.keys);
    expect(body.length).toBe(MAX_ENCRYPTED_BYTES);
    expect((await decryptPushMessage(body, device)).length).toBe(3993);

    await expect(encryptPushMessage(new Uint8Array(3994), device.keys)).rejects.toThrow(RangeError);
  });
});
