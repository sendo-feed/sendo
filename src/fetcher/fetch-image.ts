import { USER_AGENT } from "./fetch-feed";
import { toFetchableUrl, UrlNotAllowedError } from "./url-guard";

/*
 * 画像の取得（docs/decisions/images.md の 3〜5）。中継（api/images.ts）と、フィードのアイコンの
 * 確認（find-icon.ts）で使う。
 */

export type FetchImageOptions = {
  /** 取得に使う fetch。テストや移植先で差し替えられるように受け取る */
  fetch: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
};

export type FetchedImage = {
  /** 先頭のバイトで確かめた形式から決めた Content-Type。配信元の言い分は使わない */
  contentType: ImageContentType;
  /** 画像の本体。大きさの上限を超えたら、途中でエラーになる */
  body: ReadableStream<Uint8Array>;
  /** 本体の大きさ。配信元が示し、そのまま信じてよいときだけ（圧縮して送られたものは分からない） */
  contentLength: number | null;
};

export type FetchImageErrorCode =
  | "blocked_url"
  | "http_status"
  | "not_an_image"
  | "too_large"
  | "too_many_redirects"
  | "timeout"
  | "network";

/** 画像を取得できなかった */
export class FetchImageError extends Error {
  override readonly name = "FetchImageError";
  constructor(
    readonly code: FetchImageErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const DEFAULTS = { timeoutMs: 15_000, maxBytes: 10 * 1024 * 1024, maxRedirects: 5 };

/** 形式を見分けるのに読む、先頭のバイトの数 */
const SNIFF_BYTES = 16;

export type ImageContentType =
  | "image/jpeg"
  | "image/png"
  | "image/gif"
  | "image/webp"
  | "image/avif"
  | "image/x-icon";

/**
 * 先頭のバイトから、画像の形式を見分ける。通す形式でなければ null。
 *
 * SVG は通さない（同じオリジンで直接開かれると、スクリプトが動く）。HTML や XML で始まるものは、
 * どの形式にも当たらないので落ちる
 */
export function sniffImageType(head: Uint8Array): ImageContentType | null {
  const starts = (bytes: readonly number[], offset = 0) =>
    bytes.every((byte, i) => head[offset + i] === byte);
  const ascii = (text: string, offset: number) =>
    starts(
      [...text].map((char) => char.charCodeAt(0)),
      offset,
    );

  if (starts([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (ascii("GIF87a", 0) || ascii("GIF89a", 0)) return "image/gif";
  if (ascii("RIFF", 0) && ascii("WEBP", 8)) return "image/webp";
  if (ascii("ftyp", 4) && (ascii("avif", 8) || ascii("avis", 8))) return "image/avif";
  // ICO：予約の 0、種類の 1（アイコン）、画像の数（1 以上）
  if (starts([0x00, 0x00, 0x01, 0x00]) && ((head[4] ?? 0) | (head[5] ?? 0)) !== 0) {
    return "image/x-icon";
  }
  return null;
}

/**
 * 画像を取得する。
 *
 * - 取得の前に、行き先を確かめる（SSRF 対策）。リダイレクトは自分でたどり、行き先ごとに確かめる
 * - リクエストはここで新しく組み立てる。読者のブラウザから来たヘッダー（クッキー、Referer、
 *   IP の載るヘッダーなど）は受け取らないので、配信元に渡らない
 * - 形式は、先頭のバイトで確かめる。通す形式でなければ FetchImageError
 * - 時間（本体を読み終えるまで）と大きさに上限を置く
 */
export async function fetchImage(url: string, options: FetchImageOptions): Promise<FetchedImage> {
  const { timeoutMs, maxBytes, maxRedirects } = { ...DEFAULTS, ...options };
  const signal = AbortSignal.timeout(timeoutMs);
  const headers = { accept: "image/*", "user-agent": USER_AGENT };

  let current = guard(url);
  try {
    for (let redirects = 0; ; redirects++) {
      const res = await options.fetch(current, { headers, redirect: "manual", signal });

      if ([301, 302, 303, 307, 308].includes(res.status)) {
        await res.body?.cancel();
        const location = res.headers.get("location");
        if (!location) throw new FetchImageError("http_status", "redirect without location");
        if (redirects >= maxRedirects) {
          throw new FetchImageError("too_many_redirects", `more than ${maxRedirects} redirects`);
        }
        current = guard(new URL(location, current));
        continue;
      }
      if (res.status !== 200) {
        await res.body?.cancel();
        throw new FetchImageError("http_status", `unexpected status ${res.status}`);
      }

      const declared = parseLength(res.headers.get("content-length"));
      if (declared !== null && declared > maxBytes) {
        await res.body?.cancel();
        throw new FetchImageError("too_large", `content-length ${declared} exceeds ${maxBytes}`);
      }
      if (!res.body) throw new FetchImageError("not_an_image", "empty body");

      const reader = res.body.getReader();
      const head = await readHead(reader, maxBytes);
      const contentType = sniffImageType(head);
      if (contentType === null) {
        await reader.cancel();
        throw new FetchImageError("not_an_image", "not a supported image format");
      }
      return {
        contentType,
        body: limitedStream(head, reader, maxBytes),
        // 圧縮して送られた本体は fetch が展開するので、Content-Length は展開後の大きさと合わない
        contentLength: res.headers.has("content-encoding") ? null : declared,
      };
    }
  } catch (error) {
    if (error instanceof FetchImageError) throw error;
    if (signal.aborted) throw new FetchImageError("timeout", `timed out after ${timeoutMs}ms`);
    throw new FetchImageError("network", error instanceof Error ? error.message : String(error));
  }
}

function guard(url: string | URL): URL {
  try {
    return toFetchableUrl(url);
  } catch (error) {
    if (error instanceof UrlNotAllowedError)
      throw new FetchImageError("blocked_url", error.message);
    throw error;
  }
}

function parseLength(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value.trim())) return null;
  return Number(value);
}

/** 形式を見分けられるだけの先頭のバイトを読む（本体がそれより短ければ、あるだけ） */
async function readHead(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < SNIFF_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new FetchImageError("too_large", `body exceeds ${maxBytes} bytes`);
    }
  }
  const head = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    head.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return head;
}

/** 先に読んだ分に続けて、残りをそのまま流す。読んだ量が上限を超えたら、エラーにして止める */
function limitedStream(
  head: Uint8Array,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  maxBytes: number,
): ReadableStream<Uint8Array> {
  let total = head.byteLength;
  let sentHead = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!sentHead) {
        sentHead = true;
        if (head.byteLength > 0) {
          controller.enqueue(head);
          return;
        }
      }
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        controller.error(new FetchImageError("too_large", `body exceeds ${maxBytes} bytes`));
        return;
      }
      controller.enqueue(value);
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
}
