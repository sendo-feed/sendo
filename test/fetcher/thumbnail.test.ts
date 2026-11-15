import { describe, expect, it } from "vitest";
import { parseFeed } from "../../src/fetcher/parse-feed";
import { firstImageSrc, MAX_IMAGE_URL_LENGTH } from "../../src/fetcher/thumbnail";

const BASE = "https://example.com/feed.xml";
const NS =
  'xmlns:media="http://search.yahoo.com/mrss/" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"';

const rss = (item: string) =>
  parseFeed(
    `<rss version="2.0" ${NS}><channel><title>t</title><item>${item}</item></channel></rss>`,
    BASE,
  ).items[0]?.thumbnailUrl;

describe("記事のサムネイル", () => {
  it("media:thumbnail を、ほかの候補より優先する", () => {
    expect(
      rss(`<title>a</title>
        <enclosure url="https://example.com/enclosure.jpg" type="image/jpeg" length="1"/>
        <media:content url="https://example.com/content.jpg" medium="image"/>
        <media:thumbnail url="https://example.com/thumb.jpg"/>
        <description>&lt;img src="https://example.com/body.jpg"&gt;</description>`),
    ).toBe("https://example.com/thumb.jpg");
  });

  it("media:group や media:content の中の media:thumbnail も採る", () => {
    expect(
      rss(`<media:group><media:content url="https://example.com/v.mp4" type="video/mp4">
        <media:thumbnail url="https://example.com/poster.jpg"/></media:content></media:group>`),
    ).toBe("https://example.com/poster.jpg");
  });

  it("画像の media:content を採り、動画は採らない", () => {
    expect(
      rss(`<media:content url="https://example.com/v.mp4" type="video/mp4"/>
        <media:content url="https://example.com/p.webp" type="image/webp"/>`),
    ).toBe("https://example.com/p.webp");
  });

  it("画像の enclosure を採り、音声は採らない", () => {
    expect(
      rss(`<enclosure url="https://example.com/a.mp3" type="audio/mpeg" length="1"/>
        <enclosure url="https://example.com/e.png" type="image/png" length="1"/>`),
    ).toBe("https://example.com/e.png");
    expect(
      rss(`<enclosure url="https://example.com/a.mp3" type="audio/mpeg" length="1"/>`),
    ).toBeNull();
  });

  it("itunes:image を採る", () => {
    expect(rss(`<itunes:image href="https://example.com/episode.jpg"/>`)).toBe(
      "https://example.com/episode.jpg",
    );
  });

  it("本文の最初の <img> を採る。相対 URL はフィードの URL から解決する", () => {
    expect(
      rss(
        `<content:encoded><![CDATA[<p>hi</p><img src="/img/a&amp;b.png"><img src="/second.png">]]></content:encoded>`,
      ),
    ).toBe("https://example.com/img/a&b.png");
  });

  it("計測用の画像（幅か高さが 1〜2）は飛ばす", () => {
    expect(
      rss(`<description><![CDATA[<img src="https://t.example.com/pixel.gif" width="1" height="1">
        <img src="https://example.com/real.jpg" width="640">]]></description>`),
    ).toBe("https://example.com/real.jpg");
  });

  it("http ／ https でない URL、長すぎる URL は採らない", () => {
    expect(rss(`<media:thumbnail url="data:image/png;base64,AAAA"/>`)).toBeNull();
    expect(rss(`<media:thumbnail url="javascript:alert(1)"/>`)).toBeNull();
    const long = `https://example.com/${"a".repeat(MAX_IMAGE_URL_LENGTH)}`;
    expect(rss(`<media:thumbnail url="${long}"/>`)).toBeNull();
  });

  it("画像がなければ null", () => {
    expect(rss(`<title>a</title><description>text only</description>`)).toBeNull();
  });

  it("Atom：rel=enclosure の画像のリンクと、HTML の本文から採る", () => {
    const atom = (entry: string) =>
      parseFeed(
        `<feed xmlns="http://www.w3.org/2005/Atom"><title>t</title><entry><id>1</id>${entry}</entry></feed>`,
        BASE,
      ).items[0]?.thumbnailUrl;
    expect(atom(`<link rel="enclosure" type="image/jpeg" href="https://example.com/e.jpg"/>`)).toBe(
      "https://example.com/e.jpg",
    );
    expect(atom(`<content type="html">&lt;img src="https://example.com/c.jpg"&gt;</content>`)).toBe(
      "https://example.com/c.jpg",
    );
    // プレーンテキストの本文は、HTML として読まない
    expect(
      atom(`<content type="text">&lt;img src="https://example.com/c.jpg"&gt;</content>`),
    ).toBeNull();
  });

  it("JSON Feed：画像の添付、image、本文の順に採る", () => {
    const json = (item: object) =>
      parseFeed(
        JSON.stringify({
          version: "https://jsonfeed.org/version/1.1",
          title: "t",
          items: [{ id: "1", ...item }],
        }),
        BASE,
      ).items[0]?.thumbnailUrl;
    expect(
      json({
        image: "https://example.com/image.jpg",
        attachments: [{ url: "https://example.com/att.png", mime_type: "image/png" }],
      }),
    ).toBe("https://example.com/att.png");
    expect(
      json({ image: "https://example.com/image.jpg", content_html: "<img src='/b.png'>" }),
    ).toBe("https://example.com/image.jpg");
    expect(json({ content_html: "<img src='/b.png'>" })).toBe("https://example.com/b.png");
  });

  it("フィード自身のアイコン（Atom の icon、JSON Feed の icon ／ favicon）を読む", () => {
    expect(
      parseFeed(
        `<feed xmlns="http://www.w3.org/2005/Atom"><title>t</title><icon>/icon.png</icon></feed>`,
        BASE,
      ).iconUrl,
    ).toBe("https://example.com/icon.png");
    const json = (feed: object) =>
      parseFeed(
        JSON.stringify({
          version: "https://jsonfeed.org/version/1.1",
          title: "t",
          items: [],
          ...feed,
        }),
        BASE,
      ).iconUrl;
    expect(json({ icon: "https://example.com/i.png", favicon: "https://example.com/f.ico" })).toBe(
      "https://example.com/i.png",
    );
    expect(json({ favicon: "https://example.com/f.ico" })).toBe("https://example.com/f.ico");
    expect(json({})).toBeNull();
  });
});

describe("firstImageSrc", () => {
  it("コメントや script の中の <img> は読まない", () => {
    expect(
      firstImageSrc(
        `<!-- <img src="a.png"> --><script>"<img src='b.png'>"</script><img src="c.png">`,
      ),
    ).toBe("c.png");
  });

  it("src のない <img> は飛ばす", () => {
    expect(firstImageSrc(`<img alt="x"><img src=""><img src="d.png">`)).toBe("d.png");
    expect(firstImageSrc("<p>no image</p>")).toBeNull();
  });
});
