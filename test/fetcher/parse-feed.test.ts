import { describe, expect, it } from "vitest";
import {
  cleanCategories,
  htmlToText,
  MAX_SUMMARY_LENGTH,
  normalizeText,
  ParseFeedError,
  parseFeed,
  stripTags,
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
      iconUrl: null,
      items: [
        {
          id: "post-1",
          url: "https://example.com/posts/1",
          title: "First",
          summary: "Hello world",
          author: "Alice",
          publishedAt: new Date("2026-11-10T01:02:03Z"),
          publishedTimeKnown: true,
          thumbnailUrl: null,
          contentHtml: "<p>Hello <b>world</b></p>",
          categories: [],
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
      publishedTimeKnown: true,
      thumbnailUrl: null,
      contentHtml: "Short",
      categories: [],
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
      publishedTimeKnown: true,
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

    expect(feed.items[0]).toMatchObject({ publishedAt: null, publishedTimeKnown: false });
  });

  it("公開日時に時刻（時と分）まで書いてあるかを記録する（docs/decisions/jobs.md の 11）", () => {
    const rss = parseFeed(
      `<rss version="2.0"><channel><title>t</title>
        <item><guid>with-time</guid><pubDate>Fri, 20 Nov 2026 07:00:00 +0900</pubDate></item>
        <item><guid>no-date</guid></item>
      </channel></rss>`,
      BASE,
    );
    expect(
      rss.items.map(({ id, publishedAt, publishedTimeKnown }) => ({
        id,
        publishedAt,
        publishedTimeKnown,
      })),
    ).toEqual([
      {
        id: "with-time",
        publishedAt: new Date("2026-11-19T22:00:00Z"),
        publishedTimeKnown: true,
      },
      { id: "no-date", publishedAt: null, publishedTimeKnown: false },
    ]);

    const atom = parseFeed(
      `<feed xmlns="http://www.w3.org/2005/Atom"><title>a</title><id>urn:a</id>
        <updated>2026-11-20T07:00:00Z</updated>
        <entry><id>urn:1</id><title>1</title><published>2026-11-20T07:00:00Z</published>
          <updated>2026-11-20T07:00:00Z</updated></entry>
      </feed>`,
      BASE,
    );
    expect(atom.items[0]).toMatchObject({
      publishedAt: new Date("2026-11-20T07:00:00Z"),
      publishedTimeKnown: true,
    });

    // 日付だけなら、日付は使うが、時刻は分からないものとして扱う
    const json = parseFeed(
      JSON.stringify({
        version: "https://jsonfeed.org/version/1.1",
        title: "j",
        items: [{ id: "date-only", date_published: "2026-11-20" }],
      }),
      BASE,
    );
    expect(json.items[0]).toMatchObject({
      publishedAt: new Date("2026-11-20T00:00:00Z"),
      publishedTimeKnown: false,
    });
  });

  it("フィードでなければ ParseFeedError を投げる", () => {
    expect(() => parseFeed("<html><body>not a feed</body></html>", BASE)).toThrow(ParseFeedError);
    expect(() => parseFeed("", BASE)).toThrow(ParseFeedError);
  });
});

describe("parseFeed のプレーンテキストの欄", () => {
  it("JSON Feed の summary と content_text は、タグに見える文字も残す", () => {
    const feed = parseFeed(
      JSON.stringify({
        version: "https://jsonfeed.org/version/1.1",
        title: "A <B> &amp; C",
        items: [
          { id: "1", title: "Use <vector> in C++", content_text: "x < y && y > z" },
          { id: "2", summary: "a &lt; b" },
          { id: "3", content_html: "<p>x &lt; y</p>" },
        ],
      }),
      BASE,
    );

    expect(feed.title).toBe("A <B> &amp; C");
    expect(feed.items.map(({ title, summary }) => ({ title, summary }))).toEqual([
      { title: "Use <vector> in C++", summary: "x < y && y > z" },
      { title: null, summary: "a &lt; b" },
      { title: null, summary: "x < y" },
    ]);
  });

  it("RSS のタイトルはプレーンテキストとして扱い、description だけ HTML として扱う", () => {
    const feed = parseFeed(
      `<rss version="2.0"><channel><title>t</title>
        <item><title>x &lt; y &amp;&amp; y &gt; z</title>
          <description>&lt;p&gt;x &amp;lt; y&lt;/p&gt;</description></item>
      </channel></rss>`,
      BASE,
    );

    expect(feed.items[0]).toMatchObject({ title: "x < y && y > z", summary: "x < y" });
  });

  it("Atom は type 属性で HTML かどうかを決める", () => {
    const feed = parseFeed(
      `<feed xmlns="http://www.w3.org/2005/Atom"><title>f</title><id>f</id>
        <updated>2026-11-01T00:00:00Z</updated>
        <entry><id>1</id><updated>2026-11-01T00:00:00Z</updated>
          <title type="text">a &lt;b&gt; c</title><summary type="html">&lt;i&gt;s&lt;/i&gt;</summary></entry>
      </feed>`,
      BASE,
    );

    expect(feed.items[0]).toMatchObject({ title: "a <b> c", summary: "s" });
  });
});

describe("normalizeText", () => {
  it("空白をまとめるだけで、中身には手を加えない", () => {
    expect(normalizeText("  a <b>\n\n &amp; c ", 100)).toBe("a <b> &amp; c");
  });
});

describe("htmlToText", () => {
  it("タグ、script、コメントを除き、空白をまとめる", () => {
    expect(htmlToText("<p>a <script>alert(1)</script><!-- c --><b>b</b>\n\n c</p>", 100)).toBe(
      "a b c",
    );
  });

  it("文字参照をもとに戻す", () => {
    expect(htmlToText("1 &lt; 2 &amp;&amp; &#x3042;&#12354; &raquo; &hellip;", 100)).toBe(
      "1 < 2 && ああ » …",
    );
  });

  it("長すぎれば切り詰める（サロゲートペアを分断しない）", () => {
    const text = htmlToText("😀".repeat(MAX_SUMMARY_LENGTH + 10), MAX_SUMMARY_LENGTH);
    expect([...(text ?? "")]).toHaveLength(MAX_SUMMARY_LENGTH);
    expect(text?.endsWith("…")).toBe(true);
  });

  it("中身がなければ null", () => {
    expect(htmlToText("  <br/> ", 100)).toBeNull();
    expect(htmlToText(undefined, 100)).toBeNull();
  });
});

describe("stripTags", () => {
  it("タグとみなすのは「<」の次が英字などのときだけ", () => {
    expect(htmlToText("<p>x < y && 1<2</p>", 100)).toBe("x < y && 1<2");
  });

  it("script と style は中身ごと除き、似た名前のタグは普通のタグとして扱う", () => {
    expect(htmlToText("a<script>alert(1)</script>b<style>p{}</STYLE >c<scriptx>d", 100)).toBe(
      "a b c d",
    );
  });

  it("属性の値の中の「>」で、タグを途中で切らない", () => {
    expect(htmlToText('<p><a title="x > y" href="/">link</a> text</p>', 100)).toBe("link text");
  });

  it("閉じていないタグ、コメント、script に当たったら、そこで打ち切る", () => {
    expect(htmlToText("a <b c", 100)).toBe("a");
    expect(htmlToText("a <!-- b", 100)).toBe("a");
    expect(htmlToText("a <script> b", 100)).toBe("a");
  });

  // 二乗の時間がかかる実装だと、どれもテストの制限時間（5 秒）を大きく超える
  it.each([
    ["閉じていない「<a」の繰り返し", "<a".repeat(300_000)],
    ["閉じていないコメントの繰り返し", "<!--".repeat(300_000)],
    ["閉じていない script の繰り返し", "<script>".repeat(300_000)],
    ["閉じていないタグと「>」の組み合わせ", `${"<a".repeat(150_000)}>`],
    ["文字参照に見える長い英字", `&${"a".repeat(1_000_000)}`],
  ])("悪意のある入力でも長さに比例する時間で終わる：%s", (_label, input) => {
    expect(() => htmlToText(input, 500)).not.toThrow();
    expect(typeof stripTags(input)).toBe("string");
  });
});

describe("parseFeed のフィードのカテゴリ（docs/decisions/article-analysis.md の 8）", () => {
  it("RSS の category を、フィードに出てきた順で読む", () => {
    // はてなブログの RSS の形
    const feed = parseFeed(
      `<rss version="2.0"><channel><title>Blog</title><link>https://h.example/</link>
        <item><title>A</title><link>https://h.example/entry/1</link>
          <category>技術</category><category domain="https://h.example/tags">Rust</category>
          <category>  Kubernetes  </category><category>2024</category><category>2024.11</category>
          <category>R</category><category>技術</category><category></category>
        </item>
      </channel></rss>`,
      BASE,
    );
    expect(feed.items[0]?.categories).toEqual(["技術", "Rust", "Kubernetes"]);
  });

  it("Atom の category は label を使い、なければ term を使う", () => {
    const feed = parseFeed(
      `<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title><id>urn:feed</id>
        <entry><id>urn:1</id><title>A</title><link href="https://a.example/1"/>
          <category term="rust" label="Rust"/><category scheme="https://a.example/tags" term="Go"/>
          <category term="ai" label="  "/>
        </entry>
      </feed>`,
      BASE,
    );
    expect(feed.items[0]?.categories).toEqual(["Rust", "Go", "ai"]);
  });

  it("JSON Feed の tags を読み、制御文字と対になっていないサロゲートを落とす", () => {
    const feed = parseFeed(
      `{"version":"https://jsonfeed.org/version/1.1","title":"J","items":[{"id":"1","url":"https://j.example/1",
        "tags":["生成\\u0007AI","\\ud800Claude","Code\\udc00","ＡＷＳ"]}]}`,
      BASE,
    );
    expect(feed.items[0]?.categories).toEqual(["生成AI", "Claude", "Code", "ＡＷＳ"]);
  });

  it("RSS 1.0（RDF）にはカテゴリを付けない", () => {
    const feed = parseFeed(
      `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/"
        xmlns:dc="http://purl.org/dc/elements/1.1/">
        <channel rdf:about="https://r.example/"><title>R</title><link>https://r.example/</link></channel>
        <item rdf:about="https://r.example/1"><title>A</title><link>https://r.example/1</link>
          <dc:subject>Rust</dc:subject></item>
      </rdf:RDF>`,
      BASE,
    );
    expect(feed.items[0]?.categories).toEqual([]);
  });
});

describe("cleanCategories", () => {
  it("表記と鍵のどちらも 2〜40 コードポイントで、数字だけでないものを、重なりを除いて 10 個まで残す", () => {
    expect(
      cleanCategories(["ab", "a", "あ".repeat(40), "あ".repeat(41), "1.0", "1 2", "١٢"]),
    ).toEqual(["ab", "あ".repeat(40)]);
    // 小文字にすると長さが倍になる文字：表記は 30、鍵は 60
    expect(cleanCategories(["İ".repeat(30)])).toEqual([]);
    // NFKC で 1 文字が 4 文字になる文字
    expect(cleanCategories(["㍿"])).toEqual(["㍿"]);
    const many = Array.from({ length: 12 }, (_, i) => `Tag${i}`);
    expect(cleanCategories(["2024", ...many])).toEqual(many.slice(0, 10));
    expect(cleanCategories([" \t ", null, undefined])).toEqual([]);
  });
});
