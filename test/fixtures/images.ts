/** テスト用の画像の先頭のバイト（形式を見分けるのに足りるだけ） */
const bytes = (head: readonly number[], length = 64) => {
  const data = new Uint8Array(Math.max(length, head.length));
  data.set(head);
  return data;
};
const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));

export const PNG = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const JPEG = bytes([0xff, 0xd8, 0xff, 0xe0]);
export const GIF = bytes(ascii("GIF89a"));
export const WEBP = bytes([...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WEBP")]);
export const AVIF = bytes([0, 0, 0, 0x1c, ...ascii("ftypavif")]);
export const ICO = bytes([0x00, 0x00, 0x01, 0x00, 0x01, 0x00]);
export const SVG = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
);
export const HTML = new TextEncoder().encode("<!doctype html><script>alert(1)</script>");
