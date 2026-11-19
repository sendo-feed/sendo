import { describe, expect, it } from "vitest";
import {
  decode,
  FetchFeedError,
  fetchFeed,
  parseRetryAfter,
  USER_AGENT,
} from "../../src/fetcher/fetch-feed";
import { fakeFetch } from "../helpers";

async function errorCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof FetchFeedError) return error.code;
    throw error;
  }
  throw new Error("expected FetchFeedError");
}

describe("fetchFeed", () => {
  it("本文と ETag ／ Last-Modified を返す", async () => {
    const { fetch, calls } = fakeFetch(
      () =>
        new Response("<rss/>", {
          headers: { etag: '"v1"', "last-modified": "Mon, 10 Nov 2026 00:00:00 GMT" },
        }),
    );

    const result = await fetchFeed("https://example.com/feed", { fetch });

    expect(result).toEqual({
      status: "ok",
      url: "https://example.com/feed",
      body: "<rss/>",
      etag: '"v1"',
      lastModified: "Mon, 10 Nov 2026 00:00:00 GMT",
    });
    expect(calls[0]?.headers.get("user-agent")).toBe(USER_AGENT);
  });

  it("前回の ETag ／ Last-Modified を送り、304 なら本文を読まない", async () => {
    const { fetch, calls } = fakeFetch(() => new Response(null, { status: 304 }));

    const result = await fetchFeed("https://example.com/feed", {
      fetch,
      etag: '"v1"',
      lastModified: "Mon, 10 Nov 2026 00:00:00 GMT",
    });

    expect(result.status).toBe("not-modified");
    expect(calls[0]?.headers.get("if-none-match")).toBe('"v1"');
    expect(calls[0]?.headers.get("if-modified-since")).toBe("Mon, 10 Nov 2026 00:00:00 GMT");
  });

  it("リダイレクトをたどり、最後の URL を返す", async () => {
    const { fetch } = fakeFetch((url) =>
      url.pathname === "/old"
        ? new Response(null, { status: 301, headers: { location: "/new" } })
        : new Response("<rss/>"),
    );

    const result = await fetchFeed("https://example.com/old", { fetch });

    expect(result).toMatchObject({ status: "ok", url: "https://example.com/new" });
  });

  it("内部のホストへのリダイレクトを拒む", async () => {
    const { fetch, calls } = fakeFetch(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/latest/meta-data" },
        }),
    );

    expect(await errorCode(fetchFeed("https://example.com/feed", { fetch }))).toBe("blocked_url");
    expect(calls).toHaveLength(1);
  });

  it("最初から内部のホストなら、取得しない", async () => {
    const { fetch, calls } = fakeFetch(() => new Response("secret"));

    expect(await errorCode(fetchFeed("http://localhost/feed", { fetch }))).toBe("blocked_url");
    expect(calls).toHaveLength(0);
  });

  it("リダイレクトが多すぎれば止める", async () => {
    const { fetch } = fakeFetch(
      (url) => new Response(null, { status: 302, headers: { location: `${url.href}x` } }),
    );

    expect(await errorCode(fetchFeed("https://example.com/a", { fetch, maxRedirects: 3 }))).toBe(
      "too_many_redirects",
    );
  });

  it("大きすぎる本文は読まない", async () => {
    const declared = fakeFetch(
      () => new Response("x", { headers: { "content-length": String(10_000) } }),
    );
    expect(
      await errorCode(fetchFeed("https://example.com/f", { fetch: declared.fetch, maxBytes: 100 })),
    ).toBe("too_large");

    // Content-Length がなくても、読んだ量で止める
    const streamed = fakeFetch(() => new Response("x".repeat(1000)));
    expect(
      await errorCode(fetchFeed("https://example.com/f", { fetch: streamed.fetch, maxBytes: 100 })),
    ).toBe("too_large");
  });

  it("成功以外のステータスはエラーにする", async () => {
    const { fetch } = fakeFetch(() => new Response("gone", { status: 410 }));

    const error = await fetchFeed("https://example.com/f", { fetch }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(FetchFeedError);
    expect(error).toMatchObject({ code: "gone", status: 410 });
  });

  it.each([
    { body: "", headers: new Headers({ "cf-error-type": "1016" }) },
    { body: "error code: 1016", headers: new Headers() },
    {
      body: JSON.stringify({ cloudflare_error: true, error_code: 1016 }),
      headers: new Headers({ "content-type": "application/problem+json; charset=utf-8" }),
    },
  ])("530 で Cloudflare の 1016 が確認できたら DNS として扱う", async ({ body, headers }) => {
    const { fetch } = fakeFetch(() => new Response(body, { status: 530, headers }));
    await expect(fetchFeed("https://example.com/f", { fetch })).rejects.toMatchObject({
      code: "dns",
      status: 530,
    });
  });

  it.each(["error code: 1033", "1016", `error code: 1016${" ".repeat(4096)}`])(
    "530 の本文が 1016 の診断メッセージと確認できなければ HTTP エラーのままにする",
    async (body) => {
      const { fetch } = fakeFetch(() => new Response(body, { status: 530 }));
      await expect(fetchFeed("https://example.com/f", { fetch })).rejects.toMatchObject({
        code: "http_status",
        status: 530,
      });
    },
  );

  it.each(["ENOTFOUND", "EAI_AGAIN"])("名前解決の例外 %s を DNS として扱う", async (code) => {
    const { fetch } = fakeFetch(() => {
      throw new TypeError("fetch failed", { cause: Object.assign(new Error(), { code }) });
    });
    await expect(fetchFeed("https://example.com/f", { fetch })).rejects.toMatchObject({
      code: "dns",
      message: "DNS resolution failed",
    });
  });

  it("workerd の内部エラーを通信エラーとして記録し、参照 ID を外す", async () => {
    const { fetch } = fakeFetch(() => {
      throw new TypeError("internal error; reference = example");
    });
    await expect(fetchFeed("https://example.com/f", { fetch })).rejects.toMatchObject({
      code: "network",
      message: "network request failed",
    });
  });

  it("時間がかかりすぎれば打ち切る", async () => {
    const fetch: typeof globalThis.fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });

    expect(await errorCode(fetchFeed("https://example.com/f", { fetch, timeoutMs: 10 }))).toBe(
      "timeout",
    );
  });

  it("ネットワークの失敗をエラーにまとめる", async () => {
    const fetch: typeof globalThis.fetch = async () => {
      throw new TypeError("connection refused");
    };

    expect(await errorCode(fetchFeed("https://example.com/f", { fetch }))).toBe("network");
  });
});

describe("Retry-After（docs/decisions/jobs.md の 8）", () => {
  const NOW = new Date("2026-11-14T00:00:00Z");

  async function retryAfterOf(response: Response): Promise<number | undefined> {
    const { fetch } = fakeFetch(() => response);
    const error = await fetchFeed("https://example.com/f", { fetch, now: NOW }).catch(
      (e: unknown) => e,
    );
    if (!(error instanceof FetchFeedError)) throw new Error("expected FetchFeedError");
    return error.retryAfterMs;
  }

  it("429 の秒数を、待つ長さにする", async () => {
    expect(
      await retryAfterOf(new Response("", { status: 429, headers: { "retry-after": "120" } })),
    ).toBe(120_000);
  });

  it("503 の日付は、応答の Date との差で読む", async () => {
    // 相手の時計が 1 時間進んでいても、待つ長さは 3 時間
    const response = new Response("", {
      status: 503,
      headers: {
        date: "Sat, 14 Nov 2026 01:00:00 GMT",
        "retry-after": "Sat, 14 Nov 2026 04:00:00 GMT",
      },
    });
    expect(await retryAfterOf(response)).toBe(3 * 60 * 60 * 1000);
  });

  it("429 ／ 503 のほかの応答では読まない", async () => {
    expect(
      await retryAfterOf(new Response("", { status: 500, headers: { "retry-after": "120" } })),
    ).toBeUndefined();
  });

  it("Date がなければ（読めなければ）、今との差で読む", () => {
    const value = "Sat, 14 Nov 2026 00:30:00 GMT";
    expect(parseRetryAfter(value, { date: null, now: NOW })).toBe(30 * 60 * 1000);
    expect(parseRetryAfter(value, { date: "broken", now: NOW })).toBe(30 * 60 * 1000);
  });

  it("負の値、読めない値、過ぎた時刻は、なかったものとする", () => {
    for (const value of [null, "", "-1", "0", "1.5", "soon", "Fri, 13 Nov 2026 00:00:00 GMT"]) {
      expect(parseRetryAfter(value, { date: null, now: NOW }), String(value)).toBeUndefined();
    }
  });

  it("長い値もそのまま返す（上限は取得のジョブがかける）", () => {
    expect(parseRetryAfter(" 31536000 ", { date: null, now: NOW })).toBe(31_536_000_000);
  });
});

describe("decode", () => {
  // 「日本語」を Shift_JIS と EUC-JP で表したバイト列
  const sjis = new Uint8Array([0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea]);
  const eucjp = new Uint8Array([0xc6, 0xfc, 0xcb, 0xdc, 0xb8, 0xec]);

  it("Content-Type の charset に従う", () => {
    expect(decode(sjis, "application/rss+xml; charset=Shift_JIS")).toBe("日本語");
  });

  it("charset がなければ XML 宣言の encoding に従う", () => {
    const head = new TextEncoder().encode('<?xml version="1.0" encoding="EUC-JP"?>');
    const bytes = new Uint8Array([...head, ...eucjp]);
    expect(decode(bytes, "application/xml")).toBe('<?xml version="1.0" encoding="EUC-JP"?>日本語');
  });

  it("分からない文字コードなら UTF-8 で読む", () => {
    const bytes = new TextEncoder().encode("日本語");
    expect(decode(bytes, "text/xml; charset=x-unknown")).toBe("日本語");
    expect(decode(bytes, null)).toBe("日本語");
  });
});
