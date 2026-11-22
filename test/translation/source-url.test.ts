import { describe, expect, it } from "vitest";
import { normalizeSourceUrl } from "../../src/translation/source-url";

/** 同じ元記事を見分ける URL の正規化（docs/decisions/translation.md の 16） */
describe("normalizeSourceUrl", () => {
  const base = "https://lists.gnupg.org/pipermail/gnupg-announce/2026q4/000517.html";

  it.each([
    ["スキーム", "http://lists.gnupg.org/pipermail/gnupg-announce/2026q4/000517.html"],
    ["ホストの大文字", "https://Lists.GnuPG.org/pipermail/gnupg-announce/2026q4/000517.html"],
    [
      "https の既定のポート",
      "https://lists.gnupg.org:443/pipermail/gnupg-announce/2026q4/000517.html",
    ],
    [
      "http の既定のポート",
      "http://lists.gnupg.org:80/pipermail/gnupg-announce/2026q4/000517.html",
    ],
    [
      "ユーザー情報",
      "https://user:pass@lists.gnupg.org/pipermail/gnupg-announce/2026q4/000517.html",
    ],
    ["フラグメント", `${base}#top`],
    ["末尾の /", `${base}/`],
    ["末尾の / が 2 つ", `${base}//`],
    ["utm_*", `${base}?utm_source=hn&utm_medium=rss`],
    ["大文字の UTM_", `${base}?UTM_Source=hn`],
    ["fbclid と gclid", `${base}?fbclid=x&gclid=y`],
    ["空のパラメータ", `${base}?&utm_source=x&`],
  ])("%s の違いは同じとみなす", (_name, url) => {
    expect(normalizeSourceUrl(url)).toBe(base);
  });

  it("http の 443 は既定のポートでないので残す（ポートを除いてからスキームをそろえる）", () => {
    expect(normalizeSourceUrl("http://example.com:443/a")).toBe("https://example.com:443/a");
  });

  it.each([
    ["パス", "https://lists.gnupg.org/pipermail/gnupg-announce/2026q4/000518.html"],
    ["計測用でないクエリ", `${base}?page=2`],
  ])("%s の違いは別とみなす", (_name, url) => {
    expect(normalizeSourceUrl(url)).not.toBe(base);
  });

  it("計測用とそうでないパラメータが混ざると、計測用だけを除き、残す方の順は保つ", () => {
    expect(normalizeSourceUrl("https://example.com/a?b=1&utm_source=x&a=2")).toBe(
      "https://example.com/a?b=1&a=2",
    );
  });

  it("計測用のパラメータだけのクエリは、? ごと除く", () => {
    expect(normalizeSourceUrl("https://example.com/a?utm_source=x")).toBe("https://example.com/a");
  });

  it.each([
    ["URL がない", null],
    ["読めない", "not a url"],
    ["http ／ https でない", "ftp://example.com/a"],
    ["サイトの最初のページ", "https://example.com/"],
    ["計測用のパラメータを除くと最初のページ", "https://example.com/?utm_source=x"],
  ])("%s 記事は使い回さない（null）", (_name, url) => {
    expect(normalizeSourceUrl(url)).toBeNull();
  });

  it("最初のページでも、計測用でないクエリがあれば使い回す", () => {
    expect(normalizeSourceUrl("https://example.com/?p=123")).toBe("https://example.com/?p=123");
  });

  it("残すパラメータの書き方は変えない（読み直して組み直さない）", () => {
    expect(normalizeSourceUrl("https://example.com/a?q=a+b&utm_source=x")).toBe(
      "https://example.com/a?q=a+b",
    );
    expect(normalizeSourceUrl("https://example.com/a?q=a%20b")).toBe(
      "https://example.com/a?q=a%20b",
    );
    expect(normalizeSourceUrl("https://example.com/a?p")).not.toBe(
      normalizeSourceUrl("https://example.com/a?p="),
    );
  });

  it("大文字と小文字を区別せずに除くのは utm_ だけ（fbclid と gclid は、その名前だけ）", () => {
    expect(normalizeSourceUrl("https://example.com/a?FBCLID=x")).toBe(
      "https://example.com/a?FBCLID=x",
    );
  });
});
