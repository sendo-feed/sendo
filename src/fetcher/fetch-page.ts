import { readLimited, TooLargeError } from "../lib/read-limited";
import { USER_AGENT } from "./fetch-feed";
import { toFetchableUrl, UrlNotAllowedError } from "./url-guard";

/*
 * 記事のページの取得（docs/decisions/content.md の 12）。本文を抜く前に、ページの HTML を取ってくる。
 * フィードの取得（fetch-feed.ts）と同じ守りをかける。接続する IP アドレスの確認は、緩衝層の fetch
 * （platform/node/safe-fetch.ts）が行う。
 *
 * robots.txt（決定の 18）は、isAllowed で受け取り、取りにいく URL ごと（リダイレクトの行き先も）に
 * 確かめる。同じホストへの取得を 1 本ずつにする（決定の 17）のは、呼ぶ側（page-content.ts）が行う。
 */

export type FetchPageOptions = {
  /** 取得に使う fetch。テストや移植先で差し替えられるように受け取る */
  fetch: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  /**
   * URL を取りにいってよいか（robots.txt）。取りにいく前に、URL ごとに呼ぶ。なければ確かめない
   */
  isAllowed?: (url: URL) => Promise<boolean>;
};

export type FetchedPage = {
  /** リダイレクトをたどったあとの URL。本文の中のリンクと画像の基準にする */
  url: string;
  /** 応答の Content-Type。文字コードの判定に使う */
  contentType: string | null;
  bytes: Uint8Array;
};

export type FetchPageErrorCode =
  | "blocked_url"
  | "robots_disallowed"
  | "http_status"
  | "not_html"
  | "too_large"
  | "too_many_redirects"
  | "timeout"
  | "network";

/** ページを取得できなかった */
export class FetchPageError extends Error {
  override readonly name = "FetchPageError";
  constructor(
    readonly code: FetchPageErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** 大きさと時間の上限（決定の 12） */
const DEFAULTS = { timeoutMs: 10_000, maxBytes: 3 * 1024 * 1024, maxRedirects: 5 };

const HTML_TYPES = new Set(["text/html", "application/xhtml+xml"]);

/**
 * 記事のページを取得する。
 *
 * - リダイレクトは自分でたどり、行き先ごとに SSRF の確認をかける
 * - 時間と大きさに上限を設ける
 * - HTML でない応答（Content-Type が text/html ／ application/xhtml+xml でない）は受けない
 * - 読者のこと（クッキーや言語など）は渡さない。送るのは、決めたヘッダーだけ
 * - robots.txt で許されていない URL は、取りにいかない（options.isAllowed）。最初の URL の
 *   robots.txt の取得は、時間の上限に数えない（robots.txt の取得には、別に上限がある）
 */
export async function fetchPage(url: string, options: FetchPageOptions): Promise<FetchedPage> {
  const { timeoutMs, maxBytes, maxRedirects } = { ...DEFAULTS, ...options };
  const headers = {
    accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
    "user-agent": USER_AGENT,
  };

  let current = guard(url);
  await checkRobots(current, options);
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    for (let redirects = 0; ; redirects++) {
      if (redirects > 0) await checkRobots(current, options);
      const res = await options.fetch(current, { headers, redirect: "manual", signal });

      if ([301, 302, 303, 307, 308].includes(res.status)) {
        await res.body?.cancel();
        const location = res.headers.get("location");
        if (!location) throw new FetchPageError("http_status", "redirect without location");
        if (redirects >= maxRedirects) {
          throw new FetchPageError("too_many_redirects", `more than ${maxRedirects} redirects`);
        }
        current = guard(new URL(location, current));
        continue;
      }
      if (res.status !== 200) {
        await res.body?.cancel();
        throw new FetchPageError("http_status", `unexpected status ${res.status}`);
      }

      const contentType = res.headers.get("content-type");
      const mediaType = contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
      if (!HTML_TYPES.has(mediaType)) {
        await res.body?.cancel();
        throw new FetchPageError("not_html", `not an html page: ${mediaType || "(none)"}`);
      }

      const bytes = await readLimited(res.body, res.headers.get("content-length"), maxBytes);
      return { url: current.href, contentType, bytes };
    }
  } catch (error) {
    if (error instanceof FetchPageError) throw error;
    if (error instanceof TooLargeError) throw new FetchPageError("too_large", error.message);
    if (signal.aborted) throw new FetchPageError("timeout", `timed out after ${timeoutMs}ms`);
    throw new FetchPageError("network", error instanceof Error ? error.message : String(error));
  }
}

async function checkRobots(url: URL, options: FetchPageOptions): Promise<void> {
  if (options.isAllowed && !(await options.isAllowed(url))) {
    throw new FetchPageError("robots_disallowed", "disallowed by robots.txt");
  }
}

function guard(url: string | URL): URL {
  try {
    return toFetchableUrl(url);
  } catch (error) {
    if (error instanceof UrlNotAllowedError) {
      throw new FetchPageError("blocked_url", error.message);
    }
    throw error;
  }
}
