import { describe, expect, it } from "vitest";
import {
  hasMarkupBeyondText,
  sanitizeHtml,
  sanitizeHtmlWithImages,
} from "../../src/lib/sanitize-html";

const BASE = "https://blog.example.com/posts/1";
const clean = (html: string) => sanitizeHtml(html, BASE);

describe("sanitizeHtml", () => {
  it("決めたタグは通し、属性は落とす", () => {
    expect(
      clean('<p class="x" style="color:red" id="a" onclick="evil()">本文<strong>強調</strong></p>'),
    ).toBe("<p>本文<strong>強調</strong></p>");
    expect(
      clean("<h2>見出し</h2><ul><li>1</li><li>2</li></ul><pre><code>x &lt; y</code></pre>"),
    ).toBe("<h2>見出し</h2><ul><li>1</li><li>2</li></ul><pre><code>x &lt; y</code></pre>");
    expect(clean('<table><tr><td colspan="2" rowspan="x" bgcolor="red">a</td></tr></table>')).toBe(
      '<table><tr><td colspan="2">a</td></tr></table>',
    );
  });

  it("script、style、フォーム、イベントの属性を落とす", () => {
    expect(clean("<p>a</p><script>alert(1)</script><style>p{}</style><p>b</p>")).toBe(
      "<p>a</p><p>b</p>",
    );
    expect(clean('<form action="/x"><input name="a"><button>送る</button>文字</form>')).toBe(
      "文字",
    );
    expect(clean('<img src="https://img.example.com/a.png" onerror="evil()">')).toBe(
      '<img src="https://img.example.com/a.png">',
    );
    expect(clean("<svg><script>alert(1)</script><text>x</text></svg>後")).toBe("後");
  });

  it("タグのように見える文字は、文字のままエスケープし直す", () => {
    expect(clean("<p>&lt;script&gt;alert(1)&lt;/script&gt; &amp; x < y</p>")).toBe(
      "<p>&lt;script&gt;alert(1)&lt;/script&gt; &amp; x &lt; y</p>",
    );
    expect(clean("<p>&#60;img src=x onerror=alert(1)&#62;</p>")).toBe(
      "<p>&lt;img src=x onerror=alert(1)&gt;</p>",
    );
  });

  it("リンクは http ／ https ／ mailto だけを通し、絶対の URL にして rel を付ける", () => {
    expect(clean('<a href="/about" target="_blank" onclick="x()">about</a>')).toBe(
      '<a href="https://blog.example.com/about" rel="noopener noreferrer nofollow">about</a>',
    );
    expect(clean('<a href="mailto:a@example.com">mail</a>')).toBe(
      '<a href="mailto:a@example.com" rel="noopener noreferrer nofollow">mail</a>',
    );
    for (const href of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "&#106;avascript:alert(1)",
      " javascript:alert(1)",
      "java\tscript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:x",
      "",
    ]) {
      expect(clean(`<a href="${href}">x</a>`), href).not.toContain("<a");
    }
  });

  it("属性の値で、タグや属性を抜け出せない", () => {
    const out = clean('<a href="https://example.com/?q=&quot;&gt;&lt;script&gt;x">x</a>');
    expect(out).toBe(
      '<a href="https://example.com/?q=%22%3E%3Cscript%3Ex" rel="noopener noreferrer nofollow">x</a>',
    );
    expect(clean('<img src="https://img.example.com/a.png" alt="&quot; onerror=&quot;x">')).toBe(
      '<img src="https://img.example.com/a.png" alt="&quot; onerror=&quot;x">',
    );
  });

  it("画像は http ／ https の src だけを通し、srcset と picture の source は落とす", () => {
    expect(
      clean(
        '<picture><source srcset="https://img.example.com/a.webp"><img src="a.png" srcset="b.png 2x" alt="図" width="640" height="48x"></picture>',
      ),
    ).toBe('<img src="https://blog.example.com/posts/a.png" alt="図" width="640">');
    expect(clean('<img src="data:image/png;base64,AAAA">')).toBe("");
    expect(clean('<img src="javascript:alert(1)">')).toBe("");
    expect(clean("<img>")).toBe("");
  });

  it("Imgur の埋め込みの画像直リンクは、表示できる画像がない場合に本文画像にする", () => {
    const cleanPage = (html: string) => sanitizeHtml(html, BASE, { expandImgurEmbeds: true });
    const html = cleanPage(
      '<blockquote class="imgur-embed-pub"><a href="//i.imgur.com/photo.jpeg"><img src="https://pixel.wp.com/b.gif" alt="画像の説明">写真</a></blockquote>',
    );
    expect(html).toContain('<img src="https://i.imgur.com/photo.jpeg" alt="画像の説明">写真');
    expect(clean(html)).toBe(html);
    expect(
      cleanPage(
        '<blockquote class="imgur-embed-pub"><a href="https://i.imgur.com/photo.jpeg"><img src="https://example.com/thumbnail.jpeg" alt="元の画像">説明</a></blockquote>',
      ),
    ).toContain('<img src="https://example.com/thumbnail.jpeg" alt="元の画像">説明');
    expect(
      cleanPage(
        '<blockquote class="imgur-embed-pub"><a href="https://imgur.com/a/post">投稿</a></blockquote>',
      ),
    ).not.toContain("<img");
  });

  it("計測画像と同じ直リンクから Imgur の画像を復元しない", () => {
    const tracking = '<img src="//i.imgur.com/photo.jpeg#pixel" width="1px" height="1.0">';
    const link = '<a href="https://i.imgur.com/photo.jpeg#post">投稿</a>';
    for (const body of [
      tracking + link,
      link + tracking,
      link.replace("投稿", `${tracking}投稿`),
    ]) {
      const html = sanitizeHtml(`<blockquote class="imgur-embed-pub">${body}</blockquote>`, BASE, {
        expandImgurEmbeds: true,
      });
      expect(html).toContain('href="https://i.imgur.com/photo.jpeg#post"');
      expect(html).not.toContain("<img");
    }
  });

  it("X の引用には固定の埋め込みの印だけを残す", () => {
    const raw =
      '<blockquote class="twitter&#45;tweet article" onclick="x()"><a href="https://x.com/example/status/123"></a></blockquote><script src="https://platform.twitter.com/widgets.js"></script>';
    const sanitized = clean(raw);
    expect(sanitized).toBe(
      '<blockquote data-embed="x"><a href="https://x.com/example/status/123" rel="noopener noreferrer nofollow"></a></blockquote>',
    );
    expect(clean(sanitized)).toBe(sanitized);
    expect(clean('<a data-embed="x" href="https://example.com">通常のリンク</a>')).not.toContain(
      "data-embed",
    );
  });

  it("埋め込みと動画・音声は、その URL へのリンクに替える", () => {
    expect(clean('<iframe src="https://www.youtube.com/embed/x"><p>中</p></iframe>後')).toBe(
      '<a href="https://www.youtube.com/embed/x" rel="noopener noreferrer nofollow">https://www.youtube.com/embed/x</a>後',
    );
    expect(clean('<video src="/v.mp4" autoplay><source src="/v.webm"></video>')).toBe(
      '<a href="https://blog.example.com/v.mp4" rel="noopener noreferrer nofollow">https://blog.example.com/v.mp4</a>',
    );
    expect(clean('<iframe src="javascript:alert(1)"></iframe>x')).toBe("x");
    // 行き先が子の source に書いてある動画・音声。最初の 1 つだけをリンクにする
    expect(
      clean('<video controls><source src="/v.mp4"><source src="/v.webm">非対応</video>後'),
    ).toBe(
      '<a href="https://blog.example.com/v.mp4" rel="noopener noreferrer nofollow">https://blog.example.com/v.mp4</a>後',
    );
    expect(clean('<audio><source src="javascript:x"><source src="/a.mp3"></audio>')).toBe(
      '<a href="https://blog.example.com/a.mp3" rel="noopener noreferrer nofollow">https://blog.example.com/a.mp3</a>',
    );
    // 親に src があれば、子の source は使わない
    expect(clean('<video src="/v.mp4"><source src="/v.webm"></video>')).toBe(
      '<a href="https://blog.example.com/v.mp4" rel="noopener noreferrer nofollow">https://blog.example.com/v.mp4</a>',
    );
  });

  it("閉じていないタグを閉じ、開いていない閉じタグを落とす", () => {
    expect(clean("<p>a<strong>b")).toBe("<p>a<strong>b</strong></p>");
    expect(clean("a</p></div>b")).toBe("ab");
    expect(clean("<ul><li>a<p>b</ul>c")).toBe("<ul><li>a<p>b</p></li></ul>c");
  });

  it("区切りの要素は div にして残し、行の中の知らない要素は中身だけ残す", () => {
    expect(clean('<section class="x"><div>a</div><div>b</div></section>')).toBe(
      "<div><div>a</div><div>b</div></div>",
    );
    expect(clean('<span style="x">a</span><font color="red">b</font>')).toBe("ab");
  });

  it("もう一度通しても、結果は変わらない", () => {
    const input =
      '<div><p>x &amp; y &lt; z</p><a href="/a?b=1&c=2">l</a><img src="//img.example.com/a.png?x=1&y=2" alt="a&quot;b"><iframe src="https://e.example/x"></iframe></div>';
    const once = clean(input);
    expect(clean(once)).toBe(once);
  });

  it("深すぎる入れ子でも、長さに比例する時間で終わり、開いたタグを閉じる", () => {
    const out = clean(`${"<div>".repeat(5000)}x`);
    expect(out.endsWith("</div>")).toBe(true);
    expect(out.match(/<div>/g)?.length).toBe(100);
    expect(out.match(/<\/div>/g)?.length).toBe(100);
  });
});

describe("sanitizeHtml の計測用の画像（トラッキングピクセル）", () => {
  const IMG = "https://img.example.com/a.png";
  /** 画像が残るか。保存の前と返すときの 2 回通しても、結果が変わらないことも確かめる */
  const kept = (attributes: string) => {
    const once = clean(`<p>前<img src="${IMG}" ${attributes}>後</p>`);
    expect(clean(once), attributes).toBe(once);
    return once.includes("<img");
  };

  it("幅と高さがともに 1 以下の画像は落とす", () => {
    for (const attributes of [
      'width="1" height="1"',
      'width="0" height="0"',
      'width="1" height="0"',
      "width=1 height=1",
      "width='1' height='1'",
      'WIDTH="1" HEIGHT="1"',
      'width="1px" height="1px"',
      'width="1PX" height="1Px"',
      'width=" 1 " height="1 "',
      'width="1.0" height="1."',
      'width="0.5" height=".5"',
      'width="01" height="001"',
      'width="&#49;" height="1"',
      'alt="" border="0" width="1" height="1"',
    ]) {
      expect(kept(attributes), attributes).toBe(false);
    }
    expect(clean(`<p>前<img src="${IMG}" width="1" height="1">後</p>`)).toBe("<p>前後</p>");
  });

  it("style の大きさは見ず、width と height の属性だけで決める", () => {
    // style だけで 1×1 にした画像は残す（content.md の 2）
    for (const attributes of [
      'style="width:1px;height:1px"',
      'style="height: 1px !important; width: 1px !important; border: 0 !important;"',
      'width="640" height="480" style="width:1px;height:1px"',
      'width="1" style="height:1px"',
    ]) {
      expect(kept(attributes), attributes).toBe(true);
    }
    // 属性が 1×1 なら、style が何であっても落とす
    for (const attributes of [
      'width="1" height="1" style="width:640px;height:480px"',
      `width="1" height="1" style='--example:";width:640px;"'`,
    ]) {
      expect(kept(attributes), attributes).toBe(false);
    }
  });

  it("片方だけが小さい画像、大きさのない画像、隠しただけの画像は残す", () => {
    for (const attributes of [
      'width="1"',
      'height="1"',
      'width="1" height="2"',
      'width="2" height="2"',
      'width="1" height="100"',
      'width="1.5" height="1"',
      'width="1%" height="1%"',
      'width="1em" height="1em"',
      'width="" height=""',
      'width="1" height=""',
      'width="1" height="auto"',
      'width="-1" height="-1"',
      'width="0x1" height="1"',
      'style="display:none"',
      'style="visibility:hidden"',
      "hidden",
      "",
    ]) {
      expect(kept(attributes), attributes).toBe(true);
    }
  });

  it("計測に使うと分かっているアドレスの画像は、大きさによらず落とす", () => {
    for (const src of [
      // Feedburner の記事ごとの計測（http も https も）
      "http://feeds.feedburner.com/~r/ExampleBlog/~4/AbCdEf123",
      "https://feeds.feedburner.com/~r/example-blog/~4/x?utm_source=feedburner",
      "https://FEEDS.FEEDBURNER.COM/~r/ExampleBlog/~4/AbCdEf123",
      "http://feedproxy.google.com/~r/ExampleBlog/~4/AbCdEf123",
      // WordPress.com と Jetpack の統計
      "https://pixel.wp.com/b.gif?host=blog.example.com&blog=1&post=2&subd=x&ref=&feed=1",
      "http://stats.wordpress.com/b.gif?host=blog.example.com&blog=1&post=2",
      // Medium の閲覧の計測
      "https://medium.com/_/stat?event=post.clientViewed&referrerSource=full_rss&postId=abc",
      // Mailchimp の開封の計測
      "https://example.us1.list-manage.com/track/open.php?u=1&id=2&e=3",
      // Google Analytics
      "https://www.google-analytics.com/collect?v=1&tid=UA-1-1&t=pageview",
      "https://ssl.google-analytics.com/__utm.gif?utmwv=1",
    ]) {
      expect(clean(`<p>前<img src="${src}" width="600" height="400">後</p>`), src).toBe(
        "<p>前後</p>",
      );
      expect(clean(`<img src="${src}">`), src).toBe("");
    }
  });

  it("計測のアドレスに似ているだけの画像は残す", () => {
    for (const src of [
      // Feedburner でも、記事ごとの計測でないもの
      "https://feeds.feedburner.com/~ff/ExampleBlog?d=yIl2AUoC8zA",
      "https://feeds.feedburner.com/ExampleBlog",
      "https://feeds.feedburner.com/~r/ExampleBlog/~3/AbCdEf123/",
      // ホストの名前の一部が同じだけ
      "https://notpixel.wp.com/b.gif",
      "https://pixel.wp.com.example.com/b.gif",
      "https://feeds.feedburner.com.example.com/~r/a/~4/b",
      "https://example.com/pixel.wp.com/b.gif",
      "https://img.example.com/a.png?ref=https://pixel.wp.com/b.gif",
      // Medium の本物の画像
      "https://cdn-images-1.medium.com/max/1024/1*abc.png",
      "https://miro.medium.com/v2/resize:fit:1400/1*abc.png",
      "https://medium.com/_/stat/x.png",
      // Mailchimp の本物の画像
      "https://mcusercontent.com/abc/images/def.png",
      "https://gallery.mailchimp.com/abc/images/def.png",
      "https://example.us1.list-manage.com/track/click?u=1",
      // WordPress の本物の画像
      "https://i0.wp.com/blog.example.com/wp-content/uploads/a.png",
      "https://blog.files.wordpress.com/2026/11/a.png",
    ]) {
      expect(clean(`<img src="${src}">`), src).toContain("<img");
    }
  });

  it("相対の URL も、記事の URL を基準にしてから見る", () => {
    expect(
      sanitizeHtml('<img src="/~r/ExampleBlog/~4/AbC">', "https://feeds.feedburner.com/x"),
    ).toBe("");
    expect(sanitizeHtml('<img src="//pixel.wp.com/b.gif?feed=1">', BASE)).toBe("");
  });

  it("大きさの値が長くても、長さに比例する時間で終わる", () => {
    const spaces = " ".repeat(200_000);
    for (const attributes of [
      `width="1${spaces}x" height="1"`,
      `width="1" height="${spaces}1${spaces}px${spaces}x"`,
    ]) {
      expect(kept(attributes)).toBe(true);
    }
  });

  it("落としたあとの本文は、もう一度通しても変わらない", () => {
    const input = `<p>本文<img src="${IMG}" alt="図"></p><img src="https://pixel.wp.com/b.gif" width="1" height="1"><img src="${IMG}" width="1px" height="1px">`;
    const once = clean(input);
    expect(once).toBe(`<p>本文<img src="${IMG}" alt="図"></p>`);
    expect(clean(once)).toBe(once);
  });

  it("画像を落としても、まわりのリンクや文字は残す", () => {
    expect(
      clean(
        '<p>本文</p><a href="https://feeds.feedburner.com/~ff/x?a=1"><img src="https://feeds.feedburner.com/~r/x/~4/y" height="1" width="1" alt=""/></a>',
      ),
    ).toBe(
      '<p>本文</p><a href="https://feeds.feedburner.com/~ff/x?a=1" rel="noopener noreferrer nofollow"></a>',
    );
  });
});

describe("sanitizeHtmlWithImages", () => {
  it("画像の URL を差し替え、差し替え先のない画像は落とす", async () => {
    const out = await sanitizeHtmlWithImages(
      '<p><img src="https://img.example.com/a.png" alt="a"><img src="https://img.example.com/b.png"></p>',
      BASE,
      async (url) =>
        url.endsWith("a.png") ? `/api/v1/images?url=${encodeURIComponent(url)}` : null,
    );
    expect(out).toBe(
      '<p><img src="/api/v1/images?url=https%3A%2F%2Fimg.example.com%2Fa.png" alt="a"></p>',
    );
  });

  it("計測用の画像は、中継の URL を作らずに落とす（保存してある本文にも効く）", async () => {
    const seen: string[] = [];
    const out = await sanitizeHtmlWithImages(
      '<p>a<img src="https://img.example.com/a.png" width="1" height="1"><img src="https://pixel.wp.com/b.gif?feed=1"><img src="https://img.example.com/b.png" width="1"></p>',
      BASE,
      async (url) => {
        seen.push(url);
        return `/api/v1/images?url=${encodeURIComponent(url)}`;
      },
    );
    expect(seen).toEqual(["https://img.example.com/b.png"]);
    expect(out).toBe(
      '<p>a<img src="/api/v1/images?url=https%3A%2F%2Fimg.example.com%2Fb.png" width="1"></p>',
    );
  });
});

describe("hasMarkupBeyondText", () => {
  it("画像やリンクなどがあれば true、段落と強調だけなら false", () => {
    expect(hasMarkupBeyondText("<p>a<strong>b</strong></p><div>c</div>")).toBe(false);
    expect(hasMarkupBeyondText('<p><img src="https://img.example.com/a.png"></p>')).toBe(true);
    expect(hasMarkupBeyondText("<pre>x</pre>")).toBe(true);
    expect(hasMarkupBeyondText("<p>&lt;img src=x&gt;</p>")).toBe(false);
  });
});
