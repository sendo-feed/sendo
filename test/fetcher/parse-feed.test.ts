import { describe, expect, it } from "vitest";
import {
  MAX_SUMMARY_LENGTH,
  ParseFeedError,
  parseFeed,
  toPlainText,
} from "../../src/fetcher/parse-feed";

const BASE = "https://example.com/feed.xml";

describe("parseFeed", () => {
  it("RSS 2.0 を読む", () => {
    const feed = parseFeed(
      `<?xml version="1.0"?>
      <rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
        <channel>
          <title>Example &amp; Co</title>
          <link>https://example.com/</link>
          <item>
            <title>First</title>
            <link>/posts/1</link>
            <guid isPermaLink="false">post-1</guid>
            <pubDate>Mon, 10 Nov 2026 01:02:03 GMT</pubDate>
            <description>&lt;p&gt;Hello &lt;b&gt;world&lt;/b&gt;&lt;/p&gt;</description>
            <dc:creator>Alice</dc:creator>
          </item>
        </channel>
      </rss>`,
      BASE,
    );

    expect(feed).toEqual({
      title: "Example & Co",
      siteUrl: "https://example.com/",
      items: [
        {
          id: "post-1",
          url: "https://example.com/posts/1",
          title: "First",
          summary: "Hello world",
          author: "Alice",
          publishedAt: new Date("2026-11-10T01:02:03Z"),
        },
      ],
    });
  });

  it("Atom を読む", () => {
    const feed = parseFeed(
      `<feed xmlns="http://www.w3.org/2005/Atom">
        <title>Atom Blog</title>
        <link rel="self" href="https://a.example/feed"/>
        <link rel="alternate" href="https://a.example/"/>
        <id>urn:feed</id>
        <updated>2026-11-01T00:00:00Z</updated>
        <entry>
          <id>urn:entry:1</id>
          <title type="html">Entry &lt;b&gt;1&lt;/b&gt;</title>
          <link rel="alternate" href="https://a.example/1"/>
          <published>2026-10-31T12:00:00Z</published>
          <updated>2026-11-01T00:00:00Z</updated>
          <summary>Short</summary>
          <author><name>Bob</name></author>
        </entry>
      </feed>`,
      BASE,
    );

    expect(feed.title).toBe("Atom Blog");
    expect(feed.siteUrl).toBe("https://a.example/");
    expect(feed.items[0]).toEqual({
      id: "urn:entry:1",
      url: "https://a.example/1",
      title: "Entry 1",
      summary: "Short",
      author: "Bob",
      publishedAt: new Date("2026-10-31T12:00:00Z"),
    });
  });

  it("JSON Feed を読む", () => {
    const feed = parseFeed(
      JSON.stringify({
        version: "https://jsonfeed.org/version/1.1",
        title: "JSON Blog",
        home_page_url: "https://j.example/",
        items: [
          {
            id: "1",
            url: "https://j.example/1",
            title: "J",
            content_html: "<p>Body</p>",
            date_published: "2026-11-01T00:00:00Z",
            authors: [{ name: "Carol" }],
          },
        ],
      }),
      BASE,
    );

    expect(feed.title).toBe("JSON Blog");
    expect(feed.items[0]).toMatchObject({ id: "1", summary: "Body", author: "Carol" });
  });

  it("RSS 1.0（RDF）を読む", () => {
    const feed = parseFeed(
      `<?xml version="1.0"?>
      <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
               xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
        <channel rdf:about="https://r.example/"><title>RDF</title><link>https://r.example/</link><description>d</description></channel>
        <item rdf:about="https://r.example/1">
          <title>R1</title><link>https://r.example/1</link>
          <dc:date>2026-11-02T03:04:05+09:00</dc:date>
        </item>
      </rdf:RDF>`,
      BASE,
    );

    expect(feed.title).toBe("RDF");
    expect(feed.items[0]).toMatchObject({
      id: null,
      url: "https://r.example/1",
      publishedAt: new Date("2026-11-01T18:04:05Z"),
    });
  });

  it("http ／ https 以外のリンクは捨てる", () => {
    const feed = parseFeed(
      `<rss version="2.0"><channel><title>t</title><link>javascript:alert(1)</link>
        <item><title>x</title><link>javascript:alert(document.cookie)</link></item>
        <item><title>y</title><link>data:text/html,hi</link></item>
      </channel></rss>`,
      BASE,
    );

    expect(feed.siteUrl).toBeNull();
    expect(feed.items.map((item) => item.url)).toEqual([null, null]);
  });

  it("日付が読めなければ null にする", () => {
    const feed = parseFeed(
      `<rss version="2.0"><channel><title>t</title>
        <item><title>x</title><pubDate>not a date</pubDate></item>
      </channel></rss>`,
      BASE,
    );

    expect(feed.items[0]?.publishedAt).toBeNull();
  });

  it("フィードでなければ ParseFeedError を投げる", () => {
    expect(() => parseFeed("<html><body>not a feed</body></html>", BASE)).toThrow(ParseFeedError);
    expect(() => parseFeed("", BASE)).toThrow(ParseFeedError);
  });
});

describe("toPlainText", () => {
  it("タグ、script、コメントを除き、空白をまとめる", () => {
    expect(toPlainText("<p>a <script>alert(1)</script><!-- c --><b>b</b>\n\n c</p>", 100)).toBe(
      "a b c",
    );
  });

  it("文字参照をもとに戻す", () => {
    expect(toPlainText("1 &lt; 2 &amp;&amp; &#x3042;&#12354;", 100)).toBe("1 < 2 && ああ");
  });

  it("長すぎれば切り詰める（サロゲートペアを分断しない）", () => {
    const text = toPlainText("😀".repeat(MAX_SUMMARY_LENGTH + 10), MAX_SUMMARY_LENGTH);
    expect([...(text ?? "")]).toHaveLength(MAX_SUMMARY_LENGTH);
    expect(text?.endsWith("…")).toBe(true);
  });

  it("中身がなければ null", () => {
    expect(toPlainText("  <br/> ", 100)).toBeNull();
    expect(toPlainText(undefined, 100)).toBeNull();
  });
});
