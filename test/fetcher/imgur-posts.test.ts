import { describe, expect, it } from "vitest";
import { imgurImageFromPage } from "../../src/fetcher/imgur-posts";

/*
 * Imgur の投稿のページから、本文に足す画像を決める（docs/decisions/content.md の 22）。
 * ページの形は、#196 の調査で確かめたもの（実物の HTML は使わず、形だけを写した合成の HTML）。
 */

type Meta = { property?: string; name?: string; content: string };

const page = (meta: Meta[]) =>
  `<!doctype html><html><head><title>Imgur</title>${meta
    .map(({ property, name, content }) =>
      property !== undefined
        ? `<meta property="${property}" content="${content}">`
        : `<meta name="${name}" content="${content}">`,
    )
    .join("")}</head><body><div id="root"></div><script>window.x = 1;</script></body></html>`;

const imagePost = page([
  { property: "og:type", content: "article" },
  { property: "og:image", content: "https://i.imgur.com/abc123.jpeg?fb" },
  { name: "twitter:card", content: "summary_large_image" },
  { name: "twitter:image", content: "https://i.imgur.com/abc123h.jpg" },
]);

const videoPost = page([
  { property: "og:type", content: "video.other" },
  { property: "og:image", content: "https://i.imgur.com/vid456.jpg?fbplay" },
  { property: "og:video", content: "https://i.imgur.com/vid456.mp4" },
  { name: "twitter:card", content: "player" },
  { name: "twitter:image", content: "https://i.imgur.com/vid456h.jpg" },
]);

describe("imgurImageFromPage", () => {
  it("画像とアルバム（og:type が article）は og:image を使う", () => {
    expect(imgurImageFromPage(imagePost)).toBe("https://i.imgur.com/abc123.jpeg?fb");
    // アルバムでは、og:image は表紙
    expect(
      imgurImageFromPage(
        page([
          { property: "og:type", content: "article" },
          { property: "og:image", content: "https://i.imgur.com/Cover9.png?fb" },
          { name: "twitter:image", content: "https://i.imgur.com/Cover9h.jpg" },
        ]),
      ),
    ).toBe("https://i.imgur.com/Cover9.png?fb");
  });

  it("動画（og:type が video.other）は twitter:image を使う", () => {
    expect(imgurImageFromPage(videoPost)).toBe("https://i.imgur.com/vid456h.jpg");
  });

  it("og:image の拡張子は jpg ／ jpeg ／ png ／ gif ／ webp ／ avif。大文字と小文字は区別しない", () => {
    for (const ext of ["jpg", "jpeg", "png", "gif", "webp", "avif", "JPG", "Png"]) {
      const html = page([
        { property: "og:type", content: "article" },
        { property: "og:image", content: `https://i.imgur.com/abc123.${ext}` },
      ]);
      expect(imgurImageFromPage(html), ext).toBe(`https://i.imgur.com/abc123.${ext}`);
    }
  });

  it("消えた投稿（メタデータのない殻、id のない値）は null", () => {
    expect(
      imgurImageFromPage(
        '<!doctype html><html><head><title>Imgur</title></head><body><div id="root"></div></body></html>',
      ),
    ).toBeNull();
    expect(
      imgurImageFromPage(
        page([
          { property: "og:type", content: "article" },
          { property: "og:image", content: "https://i.imgur.com/?fb" },
          { name: "twitter:image", content: "https://i.imgur.com/h.jpg" },
        ]),
      ),
    ).toBeNull();
    expect(
      imgurImageFromPage(
        page([
          { property: "og:type", content: "video.other" },
          { name: "twitter:image", content: "https://i.imgur.com/h.jpg" },
        ]),
      ),
    ).toBeNull();
  });

  it("og:type がないか、ほかの値なら null", () => {
    const image = [
      { property: "og:image", content: "https://i.imgur.com/abc123.jpeg" },
      { name: "twitter:image", content: "https://i.imgur.com/abc123h.jpg" },
    ];
    expect(imgurImageFromPage(page(image))).toBeNull();
    for (const type of ["website", "video", "Article", ""]) {
      expect(
        imgurImageFromPage(page([{ property: "og:type", content: type }, ...image])),
        type,
      ).toBeNull();
    }
  });

  it("形の合わない値は使わない", () => {
    for (const value of [
      "http://i.imgur.com/abc123.jpeg",
      "https://imgur.com/abc123.jpeg",
      "https://i.imgur.com.example.com/abc123.jpeg",
      "https://i.imgur.com:8443/abc123.jpeg",
      "https://user:pass@i.imgur.com/abc123.jpeg",
      "https://i.imgur.com/abc123.mp4",
      "https://i.imgur.com/abc123.gifv",
      "https://i.imgur.com/a/abc123.jpeg",
      "https://i.imgur.com/abc-123.jpeg",
      "//i.imgur.com/abc123.jpeg",
      "/abc123.jpeg",
    ]) {
      const html = page([
        { property: "og:type", content: "article" },
        { property: "og:image", content: value },
      ]);
      expect(imgurImageFromPage(html), value).toBeNull();
    }
    for (const value of [
      "https://i.imgur.com/vid456.jpg",
      "https://i.imgur.com/vid456h.jpeg",
      "https://i.imgur.com/vid456H.jpg",
      "http://i.imgur.com/vid456h.jpg",
    ]) {
      const html = page([
        { property: "og:type", content: "video.other" },
        { name: "twitter:image", content: value },
      ]);
      expect(imgurImageFromPage(html), value).toBeNull();
    }
    // 動画で og:image しかなければ使わない（GIF では動く GIF の本体になる）
    expect(
      imgurImageFromPage(
        page([
          { property: "og:type", content: "video.other" },
          { property: "og:image", content: "https://i.imgur.com/vid456.jpg?fbplay" },
        ]),
      ),
    ).toBeNull();
  });

  it("og:* は property、twitter:* は name で探し、同じものが複数あれば最初の 1 つ", () => {
    expect(
      imgurImageFromPage(
        page([
          { name: "og:type", content: "article" },
          { name: "og:image", content: "https://i.imgur.com/abc123.jpeg" },
        ]),
      ),
    ).toBeNull();
    expect(
      imgurImageFromPage(
        page([
          { property: "og:type", content: "video.other" },
          { property: "twitter:image", content: "https://i.imgur.com/vid456h.jpg" },
        ]),
      ),
    ).toBeNull();
    expect(
      imgurImageFromPage(
        page([
          { property: "og:type", content: "article" },
          { property: "og:image", content: "https://i.imgur.com/first1.jpeg" },
          { property: "og:image", content: "https://i.imgur.com/second2.jpeg" },
        ]),
      ),
    ).toBe("https://i.imgur.com/first1.jpeg");
  });

  it("値は文字参照を戻してから見る", () => {
    expect(
      imgurImageFromPage(
        page([
          { property: "og:type", content: " article " },
          { property: "og:image", content: "https://i.imgur.com/abc123.jpeg?fb&amp;x=1" },
        ]),
      ),
    ).toBe("https://i.imgur.com/abc123.jpeg?fb&x=1");
  });
});
