import { describe, expect, it } from "vitest";
import { MAX_FOLDER_NAME_LENGTH } from "../../src/db/folders";
import { truncateUtf16 } from "../../src/lib/text";
import { MAX_OPML_FEEDS, MAX_URL_LENGTH, OpmlError, readOpml, writeOpml } from "../../src/opml";
import { FEEDLY_OPML } from "../fixtures/opml";

describe("readOpml", () => {
  it("フォルダとフィードを取り出し、URL を正規化して重複と内部の URL を飛ばす", () => {
    const { entries, skipped } = readOpml(FEEDLY_OPML);

    expect(entries).toEqual([
      { url: "https://blog.cloudflare.com/rss/", folder: "Tech" },
      { url: "https://example.com/feed.xml", folder: "Tech" },
      { url: "https://jvndb.jvn.jp/ja/rss/jvndb_new.rdf", folder: "セキュリティ" },
      { url: "https://top.example/atom.xml", folder: null },
    ]);
    expect(skipped).toEqual([
      { url: "https://example.com/feed.xml", reason: "duplicate" },
      { url: "http://169.254.169.254/latest", reason: "url_not_allowed" },
      { url: "javascript:alert(1)", reason: "url_not_allowed" },
    ]);
  });

  it("入れ子のフォルダは、いちばん近いフォルダに入れる", () => {
    const { entries } = readOpml(`<opml version="2.0"><body>
      <outline text="A"><outline text="B">
        <outline text="f" xmlUrl="https://a.example/feed"/>
      </outline></outline>
    </body></opml>`);

    expect(entries).toEqual([{ url: "https://a.example/feed", folder: "B" }]);
  });

  it("正規化すると長くなりすぎる URL は飛ばす（日本語はパーセントエンコードで長くなる）", () => {
    const long = `https://example.com/${"あ".repeat(300)}`;
    expect(long.length).toBeLessThan(MAX_URL_LENGTH);

    const { entries, skipped } = readOpml(
      `<opml version="2.0"><body><outline text="f" xmlUrl="${long}"/></body></opml>`,
    );

    expect(entries).toEqual([]);
    expect(skipped).toEqual([{ url: expect.any(String), reason: "url_too_long" }]);
  });

  it("フォルダ名は、文字列の長さ（UTF-16）で切り詰め、絵文字を途中で切らない", () => {
    const { entries } = readOpml(
      `<opml version="2.0"><body><outline text="${"😀".repeat(150)}">
        <outline text="f" xmlUrl="https://a.example/feed"/>
      </outline></body></opml>`,
    );

    const folder = entries[0]?.folder ?? "";
    expect(folder.length).toBeLessThanOrEqual(MAX_FOLDER_NAME_LENGTH);
    expect(folder).toBe("😀".repeat(MAX_FOLDER_NAME_LENGTH / 2));
    expect(truncateUtf16("a😀", 2)).toBe("a");
  });

  it("上限を超えたフィードは飛ばす", () => {
    const outlines = Array.from(
      { length: MAX_OPML_FEEDS + 2 },
      (_, i) => `<outline text="f" xmlUrl="https://f${i}.example/feed"/>`,
    ).join("");
    const { entries, skipped } = readOpml(`<opml version="2.0"><body>${outlines}</body></opml>`);

    expect(entries).toHaveLength(MAX_OPML_FEEDS);
    expect(skipped).toHaveLength(2);
    expect(skipped.every((skip) => skip.reason === "too_many")).toBe(true);
  });

  it("OPML でなければ OpmlError を投げる", () => {
    expect(() => readOpml("<rss/>")).toThrow(OpmlError);
    expect(() => readOpml("not xml")).toThrow(OpmlError);
  });
});

describe("writeOpml", () => {
  it("フォルダを入れ子の outline にし、読み戻すと同じ内容になる", () => {
    const xml = writeOpml(
      [
        {
          url: "https://a.example/feed?x=1&y=2",
          title: `A & "B" <C>`,
          siteUrl: "https://a.example/",
          folderName: "Tech & News",
        },
        { url: "https://b.example/feed", title: null, siteUrl: null, folderName: null },
      ],
      new Date("2026-11-14T00:00:00Z"),
    );

    expect(xml).toContain('<opml version="2.0">');
    expect(readOpml(xml).entries).toEqual([
      { url: "https://a.example/feed?x=1&y=2", folder: "Tech & News" },
      { url: "https://b.example/feed", folder: null },
    ]);
  });
});
