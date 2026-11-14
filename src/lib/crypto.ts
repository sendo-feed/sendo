/*
 * 秘密の文字列（トークン、セッション、ログインの state など）を作る ／ ハッシュにする。
 * Web Crypto だけを使う（docs/decisions/tech-stack.md）。
 */

/** バイト列を base64url（パディングなし）にする */
export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** base64url（パディングはあってもなくてもよい）をバイト列に戻す。形が正しくなければ undefined */
export function base64UrlDecode(text: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(text)) return undefined;
  const base64 = text.replaceAll("-", "+").replaceAll("_", "/").replace(/=+$/, "");
  try {
    const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return undefined;
  }
}

/** 推測できない乱数を base64url にした文字列 */
export function randomBase64Url(bytes: number): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** SHA-256 のハッシュ（バイト列） */
export async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

/** SHA-256 のハッシュ（16 進） */
export async function sha256Hex(text: string): Promise<string> {
  return [...(await sha256(text))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
