import { describe, expect, it } from "vitest";
import { toFetchableUrl, UrlNotAllowedError } from "../../src/fetcher/url-guard";

function reasonOf(url: string): string | null {
  try {
    toFetchableUrl(url);
    return null;
  } catch (error) {
    if (error instanceof UrlNotAllowedError) return error.reason;
    throw error;
  }
}

describe("toFetchableUrl", () => {
  it.each([
    "https://example.com/feed.xml",
    "http://example.com:8080/rss",
    "https://blog.example.co.jp/atom.xml?x=1",
    "https://93.184.215.14/feed",
    "https://[2606:4700::1111]/feed",
  ])("公開の URL は通す: %s", (url) => {
    expect(reasonOf(url)).toBeNull();
  });

  it("フラグメントを除いて正規化する", () => {
    expect(toFetchableUrl("HTTPS://Example.COM/feed#top").href).toBe("https://example.com/feed");
  });

  it.each([
    ["not a url", "invalid_url"],
    ["ftp://example.com/feed", "unsupported_scheme"],
    ["file:///etc/passwd", "unsupported_scheme"],
    ["javascript:alert(1)", "unsupported_scheme"],
    ["https://user:pass@example.com/feed", "credentials_in_url"],
    ["https://example.com:22/feed", "unsupported_port"],
  ])("形の正しくない URL を拒む: %s", (url, reason) => {
    expect(reasonOf(url)).toBe(reason);
  });

  it.each([
    "http://localhost/feed",
    "http://LOCALHOST./feed",
    "http://api.localhost/feed",
    "http://printer.local/feed",
    "http://metadata.google.internal/feed",
    "http://router.home.arpa/feed",
    "http://intranet/feed",
    "http://127.0.0.1/feed",
    "http://127.1/feed",
    "http://2130706433/feed",
    "http://0x7f000001/feed",
    "http://0.0.0.0/feed",
    "http://10.1.2.3/feed",
    "http://100.64.0.1/feed",
    "http://169.254.169.254/latest/meta-data",
    "http://172.16.0.1/feed",
    "http://172.31.255.255/feed",
    "http://192.168.1.1/feed",
    "http://198.18.0.1/feed",
    "http://224.0.0.1/feed",
    "http://255.255.255.255/feed",
    "http://[::1]/feed",
    "http://[::]/feed",
    "http://[::ffff:127.0.0.1]/feed",
    "http://[::ffff:10.0.0.1]/feed",
    "http://[64:ff9b::a9fe:a9fe]/feed",
    "http://[fc00::1]/feed",
    "http://[fd12:3456::1]/feed",
    "http://[fe80::1]/feed",
    "http://[ff02::1]/feed",
  ])("内部のホストを拒む: %s", (url) => {
    expect(reasonOf(url)).toBe("private_host");
  });

  it.each(["http://172.32.0.1/feed", "http://11.0.0.1/feed", "http://[::ffff:8.8.8.8]/feed"])(
    "内部の範囲のすぐ外は通す: %s",
    (url) => {
      expect(reasonOf(url)).toBeNull();
    },
  );
});
