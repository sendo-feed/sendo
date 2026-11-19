import { describe, expect, it } from "vitest";
import { sanitizeHtml } from "../../../src/lib/sanitize-html";
import { createPageContentExtractor, loadNativeModule } from "../../../src/platform/node/native";
import { NATIVE_MODULE } from "../../db";
import { articlePage } from "../../fixtures/pages";

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

  it("ひな形から取り除いた画像を本文の Imgur リンクから復元しない", async () => {
    const url = "https://news.example.com/posts/1";
    const photo = "https://i.imgur.com/photo.jpeg";
    const pixel = "https://i.imgur.com/pixel.jpeg";
    const hidden = "https://i.imgur.com/hidden.jpeg";
    const small = "https://i.imgur.com/small.jpeg";
    const large = "https://i.imgur.com/large.jpeg";
    const lazy = "https://i.imgur.com/lazy.jpeg";
    const alternate = "https://i.imgur.com/alternate.jpeg";
    const removed = [pixel, hidden, small, large, lazy, alternate];
    const page = articlePage().replace(
      "</h1>",
      [
        '</h1><blockquote class="imgur-embed-pub">',
        `<template><img src="${pixel}" width="1" height="1"></template>`,
        `<picture hidden><source media="(min-width: 900px)" srcset="${alternate} 2x">`,
        `<img src="${hidden}" srcset="${small} 320w, ${large} 640w" data-src="${lazy}"><img></picture>`,
        ...removed.map((href) => `<a href="${href}">画像のリンク</a>`),
        `</blockquote><blockquote class="imgur-embed-pub"><a href="${photo}">写真</a></blockquote>`,
      ].join(""),
    );
    const result = await extractor.extract({
      bytes: new TextEncoder().encode(page),
      contentType: "text/html; charset=utf-8",
      url,
    });
    expect(result).not.toBeNull();
    const html = sanitizeHtml(result?.html ?? "", url, { expandImgurEmbeds: true });
    for (const href of removed) {
      expect(html).toContain(`href="${href}"`);
      expect(html).not.toContain(`src="${href}"`);
    }
    expect(html).toContain(`src="${photo}"`);
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
  it("本文の画像リンク、HTML の候補、置き換えを Rust の仕事として呼べる", async () => {
    const images = extractor.images;
    if (!images) throw new Error("missing image processor");
    const html =
      "<p>前</p><a href='https://photo.example/view'><img src='https://photo.example/thumb.jpg' width='100' height='80'></a><p>後</p>";
    const links = await images.links(html, "https://news.example/post");
    expect(links).toEqual([
      { thumbnail: "https://photo.example/thumb.jpg", target: "https://photo.example/view" },
    ]);
    expect(
      await images.candidates({
        bytes: new TextEncoder().encode("<img src='./full.jpg' width='800' height='600'>"),
        contentType: "text/html",
        url: "https://photo.example/view",
      }),
    ).toEqual(["https://photo.example/full.jpg"]);
    expect(await images.compare(new Uint8Array([0]), null)).toMatchObject({
      eligible: false,
      matches: false,
    });
    const link = links[0];
    if (!link) throw new Error("missing image link");
    const replaced = await images.replace(html, link, "https://photo.example/full.jpg");
    expect(replaced).toContain('href="https://photo.example/view"');
    expect(replaced).toContain('src="https://photo.example/full.jpg"');
    expect(replaced.indexOf("前")).toBeLessThan(replaced.indexOf("full.jpg"));
    expect(replaced.indexOf("full.jpg")).toBeLessThan(replaced.indexOf("後"));
  });
});
