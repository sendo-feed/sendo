import { toFetchableUrl, UrlNotAllowedError } from "./url-guard";

export type FetchFeedOptions = {
  /** 取得に使う fetch。テストや移植先で差し替えられるように受け取る */
  fetch: typeof fetch;
  etag?: string | null | undefined;
  lastModified?: string | null | undefined;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
};

export type FetchFeedResult =
  | { status: "not-modified"; url: string }
  | { status: "ok"; url: string; body: string; etag: string | null; lastModified: string | null };

export type FetchFeedErrorCode =
  | "blocked_url"
  | "http_status"
  | "too_large"
  | "too_many_redirects"
  | "timeout"
  | "network";

/** フィードを取得できなかった。フィードの側の問題で、すぐにやり直しても直らない */
export class FetchFeedError extends Error {
  override readonly name = "FetchFeedError";
  constructor(
    readonly code: FetchFeedErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export const USER_AGENT = "Sendo/0.0 (+https://github.com/sendo-feed/sendo)";

const ACCEPT = [
  "application/rss+xml",
  "application/atom+xml",
  "application/feed+json",
  "application/xml;q=0.9",
  "text/xml;q=0.9",
  "application/json;q=0.8",
  "*/*;q=0.5",
].join(", ");

const DEFAULTS = { timeoutMs: 15_000, maxBytes: 5 * 1024 * 1024, maxRedirects: 5 };

/**
 * フィードを取得する。
 *
 * - ETag ／ Last-Modified を送り、変わっていなければ本文を読まない（304）
 * - リダイレクトは自分でたどり、行き先ごとに SSRF の確認をかける
 * - 時間と大きさに上限を設け、文字コードは Content-Type か XML の宣言から決める
 */
export async function fetchFeed(url: string, options: FetchFeedOptions): Promise<FetchFeedResult> {
  const { timeoutMs, maxBytes, maxRedirects } = { ...DEFAULTS, ...options };
  const signal = AbortSignal.timeout(timeoutMs);

  const headers = new Headers({ accept: ACCEPT, "user-agent": USER_AGENT });
  if (options.etag) headers.set("if-none-match", options.etag);
  if (options.lastModified) headers.set("if-modified-since", options.lastModified);

  let current = guard(url);
  try {
    for (let redirects = 0; ; redirects++) {
      const res = await options.fetch(current, { headers, redirect: "manual", signal });

      if (isRedirect(res.status)) {
        await res.body?.cancel();
        const location = res.headers.get("location");
        if (!location)
          throw new FetchFeedError("http_status", "redirect without location", res.status);
        if (redirects >= maxRedirects) {
          throw new FetchFeedError("too_many_redirects", `more than ${maxRedirects} redirects`);
        }
        current = guard(new URL(location, current));
        continue;
      }

      if (res.status === 304) {
        await res.body?.cancel();
        return { status: "not-modified", url: current.href };
      }
      if (!res.ok) {
        await res.body?.cancel();
        throw new FetchFeedError("http_status", `unexpected status ${res.status}`, res.status);
      }

      const bytes = await readLimited(res, maxBytes);
      return {
        status: "ok",
        url: current.href,
        body: decode(bytes, res.headers.get("content-type")),
        etag: res.headers.get("etag"),
        lastModified: res.headers.get("last-modified"),
      };
    }
  } catch (error) {
    if (error instanceof FetchFeedError) throw error;
    if (signal.aborted) throw new FetchFeedError("timeout", `timed out after ${timeoutMs}ms`);
    throw new FetchFeedError("network", error instanceof Error ? error.message : String(error));
  }
}

function guard(url: string | URL): URL {
  try {
    return toFetchableUrl(url);
  } catch (error) {
    if (error instanceof UrlNotAllowedError) {
      throw new FetchFeedError("blocked_url", error.message);
    }
    throw error;
  }
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function readLimited(res: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel();
    throw new FetchFeedError("too_large", `content-length ${declared} exceeds ${maxBytes}`);
  }
  if (!res.body) return new Uint8Array();

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new FetchFeedError("too_large", `body exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * 文字コードを決めて文字列にする。日本のフィードには Shift_JIS や EUC-JP もあるので、
 * Content-Type の charset、なければ XML 宣言の encoding を見る。分からなければ UTF-8。
 */
export function decode(bytes: Uint8Array, contentType: string | null): string {
  const label = charsetFromContentType(contentType) ?? encodingFromXmlDeclaration(bytes) ?? "utf-8";
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function charsetFromContentType(contentType: string | null): string | null {
  const match = contentType?.match(/charset\s*=\s*"?([\w.:-]+)"?/i);
  return match?.[1] ?? null;
}

function encodingFromXmlDeclaration(bytes: Uint8Array): string | null {
  // 宣言は先頭にあり、ASCII で書かれているので、先頭だけを latin1 として読めば足りる
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 200));
  const match = head.match(/^\s*<\?xml[^>]*encoding\s*=\s*["']([\w.:-]+)["']/i);
  return match?.[1] ?? null;
}
