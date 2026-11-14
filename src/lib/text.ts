/**
 * JavaScript の文字列の長さ（UTF-16 の単位。zod の max もこれで数える）で切り詰める。
 * 絵文字などのサロゲートペアは途中で切らない。
 */
export function truncateUtf16(value: string, maxLength: number): string {
  let out = "";
  for (const char of value) {
    if (out.length + char.length > maxLength) break;
    out += char;
  }
  return out;
}
