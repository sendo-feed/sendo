import { describe, expect, it } from "vitest";
import { decode, FetchFeedError, fetchFeed, USER_AGENT } from "../../src/fetcher/fetch-feed";
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
    expect(error).toMatchObject({ code: "http_status", status: 410 });
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
