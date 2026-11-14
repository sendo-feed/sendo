import { describe, expect, it } from "vitest";
import { findFeedLinks } from "../../src/fetcher/discover";

const BASE = "https://blog.example/posts/";

describe("findFeedLinks", () => {
  it("rel=alternate でフィードの type の <link> だけを、出てきた順に返す", () => {
    const html = `<head>
      <link rel="alternate" type="application/rss+xml" href="../feed.xml" title=" Posts ">
      <link rel="alternate stylesheet" type="text/css" href="/alt.css">
      <link rel="alternate" type="application/atom+xml; charset=utf-8" href='https://blog.example/atom'>
      <link rel=alternate type=application/feed+json href=/feed.json>
      <link rel="alternate" type="application/rss+xml" href="../feed.xml">
      <link rel="icon" type="application/rss+xml" href="/not-alternate">
      <link rel="alternate" type="application/rss+xml" href="javascript:alert(1)">
    </head>`;

    expect(findFeedLinks(html, BASE)).toEqual([
      { url: "https://blog.example/feed.xml", title: "Posts" },
      { url: "https://blog.example/atom", title: null },
      { url: "https://blog.example/feed.json", title: null },
    ]);
  });

  it("文字参照を戻し、WordPress の REST API（application/json）は候補にしない", () => {
    const html = `<head>
      <link rel="alternate" type="application/rss+xml" title="Blog &raquo; Feed" href="/feed/">
      <link rel="alternate" type="application/json" href="/wp-json/wp/v2/pages/1">
    </head>`;

    expect(findFeedLinks(html, BASE)).toEqual([
      { url: "https://blog.example/feed/", title: "Blog » Feed" },
    ]);
  });

  it("属性の値の文字参照は、属性の規則で戻す（「&not=2」は ¬ にしない）", () => {
    expect(
      findFeedLinks(
        '<link rel="alternate" type="application/rss+xml" title="A&amp;B" href="/feed?x=1&not=2&amp;y=3">',
        BASE,
      ),
    ).toEqual([{ url: "https://blog.example/feed?x=1&not=2&y=3", title: "A&B" }]);
  });

  it("相対 URL は、最初の <base href> を基準に解決する（<link> より後にあっても効く）", () => {
    const page = "https://example.com/";
    const link = '<link rel="alternate" type="application/rss+xml" href="feed.xml">';

    expect(findFeedLinks(`<base href="/blog/">${link}`, page)).toEqual([
      { url: "https://example.com/blog/feed.xml", title: null },
    ]);
    expect(findFeedLinks(`${link}<base href="/blog/"><base href="/other/">`, page)).toEqual([
      { url: "https://example.com/blog/feed.xml", title: null },
    ]);
    // http ／ https 以外の base は使わない
    expect(findFeedLinks(`<base href="javascript:x">${link}`, page)).toEqual([
      { url: "https://example.com/feed.xml", title: null },
    ]);
  });

  it("属性の値の中に「>」があっても、href まで読む", () => {
    expect(
      findFeedLinks(
        '<link rel="alternate" type="application/rss+xml" title="A > B" href="/feed.xml">',
        BASE,
      ),
    ).toEqual([{ url: "https://blog.example/feed.xml", title: "A > B" }]);
  });

  it("コメントや script の中の <link> は候補にしない", () => {
    const html = `<head>
      <!-- <link rel="alternate" type="application/rss+xml" href="/old.xml"> -->
      <script>document.write('<link rel="alternate" type="application/rss+xml" href="/js.xml">')</script>
      <link rel="alternate" type="application/rss+xml" href="/feed.xml">
    </head>`;

    expect(findFeedLinks(html, BASE)).toEqual([
      { url: "https://blog.example/feed.xml", title: null },
    ]);
  });

  // 二乗の時間がかかる実装だと、どれもテストの制限時間（5 秒）を大きく超える
  it.each([
    ["閉じていない <link の繰り返し", "<link ".repeat(200_000)],
    ["属性の多い長いタグ", `<link ${'a="b" '.repeat(200_000)}>`],
    ["閉じたタグの繰り返し", '<link rel="x">'.repeat(100_000)],
  ])("悪意のある入力でも長さに比例する時間で終わる：%s", (_label, html) => {
    expect(findFeedLinks(html, BASE)).toEqual([]);
  });
});
