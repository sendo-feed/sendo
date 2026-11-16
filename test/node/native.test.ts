import { describe, expect, it } from "vitest";
import { createPageContentExtractor, loadNativeModule } from "../../src/platform/node/native";
import { articlePage, NATIVE_MODULE } from "./helpers";

describe("Rust のモジュール（記事のページから本文を抜く）", () => {
  const extractor = createPageContentExtractor(loadNativeModule(NATIVE_MODULE));

  it("本文を抜き、リンクをページの URL を基準に絶対の URL にする", async () => {
    const result = await extractor.extract({
      bytes: new TextEncoder().encode(articlePage()),
      contentType: "text/html; charset=utf-8",
      url: "https://news.example.com/posts/1",
    });
    expect(result?.html).toContain("段落 0");
    expect(result?.html).toContain("https://news.example.com/related/0");
    expect(result?.html).not.toContain("メニュー");
    expect(result?.textLength).toBeGreaterThan(100);
    expect(result?.title).toContain("見出し");
  });

  it("Content-Type の charset で、UTF-8 でないページも読む", async () => {
    // Shift_JIS のバイト列は、Node の TextDecoder の逆向きがないので、Rust の側のテストで確かめる。
    // ここでは、charset の付いていないページが UTF-8 として読まれることを確かめる
    const result = await extractor.extract({
      bytes: new TextEncoder().encode(articlePage()),
      contentType: null,
      url: "https://news.example.com/posts/2",
    });
    expect(result?.html).toContain("段落 7");
  });

  it("本文が見つからなければ null を返す", async () => {
    const result = await extractor.extract({
      bytes: new TextEncoder().encode("<html><body></body></html>"),
      contentType: "text/html",
      url: "https://news.example.com/empty",
    });
    expect(result).toBeNull();
  });

  it("URL が正しくなければ、例外にする（プロセスは落ちない）", async () => {
    await expect(
      extractor.extract({
        bytes: new TextEncoder().encode(articlePage()),
        contentType: "text/html",
        url: "not a url",
      }),
    ).rejects.toThrow();
  });
});
