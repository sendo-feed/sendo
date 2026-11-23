import { describe, expect, it } from "vitest";
import {
  findImgurPosts,
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

describe("sanitizeHtml の Imgur の公式埋め込み", () => {
  const A = 'rel="noopener noreferrer nofollow"';
  const embed = (inner: string) =>
    `<blockquote class="imgur-embed-pub" lang="ja">${inner}</blockquote>`;

  it("画像の直リンクなら、リンクを残して、引用の終わり（リンクの外）に画像を足す", () => {
    expect(
      clean(embed('<a href="https://i.imgur.com/abc123.jpeg">View post on imgur.com</a>')),
    ).toBe(
      `<blockquote><a href="https://i.imgur.com/abc123.jpeg" ${A}>View post on imgur.com</a>` +
        '<img src="https://i.imgur.com/abc123.jpeg"></blockquote>',
    );
    // リンクを閉じていなくても、画像はリンクの外に置く
    expect(clean(embed('<p><a href="https://i.imgur.com/abc123.png">写真'))).toBe(
      `<blockquote><p><a href="https://i.imgur.com/abc123.png" ${A}>写真</a></p>` +
        '<img src="https://i.imgur.com/abc123.png"></blockquote>',
    );
  });

  it("絶対の URL にしたあとで見る。拡張子の大文字と小文字は区別せず、クエリは見ない", () => {
    // スキームのない書き方は、記事の URL（https）を基準にする
    expect(clean(embed('<a href="//i.imgur.com/abc123.JPG?1">写真</a>'))).toContain(
      '<img src="https://i.imgur.com/abc123.JPG?1">',
    );
    for (const ext of ["jpg", "jpeg", "png", "gif", "webp", "avif"]) {
      expect(clean(embed(`<a href="https://i.imgur.com/abc123.${ext}">写真</a>`))).toContain(
        "<img ",
      );
    }
    // 記事が http なら、スキームのない書き方は http になり、当たらない
    expect(
      sanitizeHtml(
        embed('<a href="//i.imgur.com/abc123.jpg">写真</a>'),
        "http://blog.example.com/1",
      ),
    ).not.toContain("<img");
  });

  it("投稿やアルバムのページ、動画、http、ほかのホストは、リンクのまま残す", () => {
    for (const href of [
      "//imgur.com/abc123",
      "https://imgur.com/a/abc123",
      "https://i.imgur.com/abc123.mp4",
      "https://i.imgur.com/abc123.gifv",
      "https://i.imgur.com/abc123",
      "http://i.imgur.com/abc123.jpg",
      "https://i.imgur.com:8443/abc123.jpg",
      "https://user:pass@i.imgur.com/abc123.jpg",
      "https://i.imgur.com.example.com/abc123.jpg",
      "https://example.com/i.imgur.com/abc123.jpg",
    ]) {
      const html = clean(embed(`<a href="${href}">写真</a>`));
      expect(html, href).not.toContain("<img");
      expect(html, href).toContain("<a href=");
    }
    // 公式埋め込みでない引用の中の直リンクは、画像にしない
    expect(
      clean('<blockquote><a href="https://i.imgur.com/abc123.jpg">写真</a></blockquote>'),
    ).not.toContain("<img");
    expect(
      clean(
        '<blockquote class="imgur-embed-public"><a href="https://i.imgur.com/a.jpg">写真</a></blockquote>',
      ),
    ).not.toContain("<img");
  });

  it("引用の中に画像が残るなら足さない。計測用の画像だけなら足す", () => {
    const link = '<a href="https://i.imgur.com/abc123.jpg">写真</a>';
    expect(clean(embed(`${link}<img src="https://i.imgur.com/other.jpg">`))).toBe(
      `<blockquote><a href="https://i.imgur.com/abc123.jpg" ${A}>写真</a>` +
        '<img src="https://i.imgur.com/other.jpg"></blockquote>',
    );
    // 落とす画像（計測用、src のないもの）は数えない
    const dropped =
      '<img src="https://pixel.example.com/t.gif" width="1" height="1"><img src="data:x">';
    expect(clean(embed(`${dropped}${link}`))).toBe(
      `<blockquote><a href="https://i.imgur.com/abc123.jpg" ${A}>写真</a>` +
        '<img src="https://i.imgur.com/abc123.jpg"></blockquote>',
    );
    // 引用の外の画像は数えない
    expect(
      clean(`<img src="/a.png">${embed(link)}<img src="/b.png">`).match(/<img /g),
    ).toHaveLength(3);
  });

  it("当てはまるリンクがいくつもあれば、最初の 1 つを使う。引用ごとに 1 枚", () => {
    const html = clean(
      embed(
        '<a href="//imgur.com/abc123">投稿</a><a href="https://i.imgur.com/one.jpg">1</a>' +
          '<a href="https://i.imgur.com/two.jpg">2</a>',
      ) + embed('<a href="https://i.imgur.com/three.jpg">3</a>'),
    );
    expect(html.match(/<img src="[^"]+">/g)).toEqual([
      '<img src="https://i.imgur.com/one.jpg">',
      '<img src="https://i.imgur.com/three.jpg">',
    ]);
    expect(html.match(/<a /g)).toHaveLength(4);
  });

  it("閉じていない引用でも、外の要素が閉じるところで画像を足す", () => {
    expect(
      clean(
        `<div>${embed('<a href="https://i.imgur.com/abc123.jpg">写真').replace("</blockquote>", "")}</div><p>続き</p>`,
      ),
    ).toBe(
      `<div><blockquote><a href="https://i.imgur.com/abc123.jpg" ${A}>写真</a>` +
        '<img src="https://i.imgur.com/abc123.jpg"></blockquote></div><p>続き</p>',
    );
  });

  it("もう一度通しても、画像は増えも減りもしない", () => {
    const once = clean(
      embed('<a href="https://i.imgur.com/abc123.jpg">写真</a>') +
        embed('<a href="//imgur.com/abc123">投稿</a>'),
    );
    expect(once.match(/<img /g)).toHaveLength(1);
    expect(clean(once)).toBe(once);
  });
});

describe("sanitizeHtml の Imgur の公式埋め込みの、文字も画像もないリンク", () => {
  const A = 'rel="noopener noreferrer nofollow"';
  const embed = (inner: string) =>
    `<blockquote class="imgur-embed-pub" lang="ja" data-id="abc123" data-context="false">${inner}</blockquote>`;

  it("リンクの文字として、絶対の URL にした行き先を出す。href はそのまま", () => {
    expect(clean(embed('<p><a href="//imgur.com/abc123"></a></p>'))).toBe(
      `<blockquote><p><a href="https://imgur.com/abc123" ${A}>https://imgur.com/abc123</a></p></blockquote>`,
    );
    // 記事が http なら、スキームのない書き方は http になる
    expect(
      sanitizeHtml(embed('<a href="//imgur.com/a/xyz"></a>'), "http://blog.example.com/1"),
    ).toBe(
      `<blockquote><a href="http://imgur.com/a/xyz" ${A}>http://imgur.com/a/xyz</a></blockquote>`,
    );
  });

  it("文字は、文字参照を戻してから、エスケープし直して出す", () => {
    expect(clean(embed('<a href="https://imgur.com/abc?a=1&amp;b=&lt;2&gt;"></a>'))).toBe(
      '<blockquote><a href="https://imgur.com/abc?a=1&amp;b=%3C2%3E" rel="noopener noreferrer nofollow">' +
        "https://imgur.com/abc?a=1&amp;b=%3C2%3E</a></blockquote>",
    );
  });

  it("空白だけのリンクも、文字のないリンクとして扱う", () => {
    for (const inner of [" ", "\n\t", "&nbsp;", "<span> </span>"]) {
      // 空白は残し、そのあとに URL を出す
      expect(clean(embed(`<a href="//imgur.com/abc123">${inner}</a>`)), inner).toMatch(
        /nofollow">\s*https:\/\/imgur\.com\/abc123<\/a>/,
      );
    }
  });

  it("文字のあるリンクは変えない", () => {
    for (const inner of ["View post on imgur.com", "<strong>写真</strong>", " x "]) {
      const html = clean(embed(`<a href="//imgur.com/abc123">${inner}</a>`));
      expect(html, inner).not.toContain(">https://imgur.com/abc123</a>");
    }
  });

  it("リンクの中に画像が残れば変えない。落ちる画像だけなら URL を出す", () => {
    expect(clean(embed('<a href="//imgur.com/abc123"><img src="/a.png"></a>'))).toBe(
      `<blockquote><a href="https://imgur.com/abc123" ${A}><img src="https://blog.example.com/a.png"></a></blockquote>`,
    );
    const dropped =
      '<img src="https://pixel.example.com/t.gif" width="1" height="1"><img src="data:x">';
    expect(clean(embed(`<a href="//imgur.com/abc123">${dropped}</a>`))).toBe(
      `<blockquote><a href="https://imgur.com/abc123" ${A}>https://imgur.com/abc123</a></blockquote>`,
    );
    // 中身ごと落ちる要素の文字は数えない
    expect(clean(embed('<a href="//imgur.com/abc123"><svg><text>x</text></svg></a>'))).toContain(
      ">https://imgur.com/abc123</a>",
    );
  });

  it("閉じていないリンクや、次のリンクで閉じるリンクでも、それぞれに URL を出す", () => {
    expect(clean(embed('<a href="//imgur.com/one"><a href="//imgur.com/two">'))).toBe(
      `<blockquote><a href="https://imgur.com/one" ${A}>https://imgur.com/one</a>` +
        `<a href="https://imgur.com/two" ${A}>https://imgur.com/two</a></blockquote>`,
    );
  });

  it("直リンクの形は、今と同じ結果になる（文字のない直リンクには、URL と画像の両方が出る）", () => {
    expect(
      clean(embed('<a href="https://i.imgur.com/abc123.jpeg">View post on imgur.com</a>')),
    ).toBe(
      `<blockquote><a href="https://i.imgur.com/abc123.jpeg" ${A}>View post on imgur.com</a>` +
        '<img src="https://i.imgur.com/abc123.jpeg"></blockquote>',
    );
    expect(clean(embed('<a href="https://i.imgur.com/abc123.jpeg"></a>'))).toBe(
      `<blockquote><a href="https://i.imgur.com/abc123.jpeg" ${A}>https://i.imgur.com/abc123.jpeg</a>` +
        '<img src="https://i.imgur.com/abc123.jpeg"></blockquote>',
    );
  });

  it("公式埋め込みでない引用や、引用の外の、文字のないリンクは変えない", () => {
    expect(clean('<blockquote><a href="//imgur.com/abc123"></a></blockquote>')).toBe(
      `<blockquote><a href="https://imgur.com/abc123" ${A}></a></blockquote>`,
    );
    expect(
      clean(`<a href="//imgur.com/x"></a>${embed("<p>文</p>")}<a href="//imgur.com/y"></a>`),
    ).toBe(
      `<a href="https://imgur.com/x" ${A}></a><blockquote><p>文</p></blockquote>` +
        `<a href="https://imgur.com/y" ${A}></a>`,
    );
  });

  it("もう一度通しても、文字は二重にならない", () => {
    const once = clean(embed('<a href="//imgur.com/abc123"></a>'));
    expect(clean(once)).toBe(once);
  });

  it("入れ子の引用の中のリンクと、mailto のリンクにも出す", () => {
    expect(clean(embed('<blockquote><a href="//imgur.com/abc123"></a></blockquote>'))).toBe(
      `<blockquote><blockquote><a href="https://imgur.com/abc123" ${A}>https://imgur.com/abc123</a></blockquote></blockquote>`,
    );
    expect(clean(embed('<a href="mailto:a@example.com"></a>'))).toContain(
      ">mailto:a@example.com</a>",
    );
  });

  it("リンクの中で埋め込みをリンクに替えるときは、先に Imgur のリンクを閉じて URL を出す", () => {
    for (const [inner, src] of [
      ['<iframe src="https://v.example.com/x"></iframe>', "https://v.example.com/x"],
      ['<video><source src="https://v.example.com/x.mp4"></video>', "https://v.example.com/x.mp4"],
    ] as const) {
      const once = clean(embed(`<a href="//imgur.com/abc123">${inner}</a>`));
      expect(once, inner).toBe(
        `<blockquote><a href="https://imgur.com/abc123" ${A}>https://imgur.com/abc123</a>` +
          `<a href="${src}" ${A}>${src}</a></blockquote>`,
      );
      expect(clean(once), inner).toBe(once);
    }
    // 文字のあるリンクも、替えたリンクの前で閉じる（URL は出さない）
    const once = clean(
      embed('<a href="//imgur.com/abc123">写真<iframe src="https://v.example.com/x"></iframe></a>'),
    );
    expect(once).toBe(
      `<blockquote><a href="https://imgur.com/abc123" ${A}>写真</a>` +
        `<a href="https://v.example.com/x" ${A}>https://v.example.com/x</a></blockquote>`,
    );
    expect(clean(once)).toBe(once);
  });
});

describe("sanitizeHtml の X の公式の埋め込みコード", () => {
  const A = 'rel="noopener noreferrer nofollow"';
  const ID = "1234567890123456789";
  const POST = `https://x.com/example_user/status/${ID}`;
  const tweet = (inner: string, attributes = 'class="twitter-tweet" data-lang="ja"') =>
    `<blockquote ${attributes}>${inner}</blockquote>`;
  const marked = (id: string) => `<blockquote data-x-post="${id}">`;

  it("公式の形、文が空の形、リンクが段落の中だけの形、リンクだけの形で、印を付ける", () => {
    expect(
      clean(
        tweet(
          `<p lang="ja" dir="ltr">投稿の文 <a href="https://t.co/abc">pic.twitter.com/abc</a></p>` +
            `&mdash; 名前 (@example_user) <a href="${POST}?ref_src=twsrc%5Etfw">November 21, 2026</a>`,
        ),
      ),
    ).toBe(
      `${marked(ID)}<p>投稿の文 <a href="https://t.co/abc" ${A}>pic.twitter.com/abc</a></p>` +
        `— 名前 (@example_user) <a href="${POST}?ref_src=twsrc%5Etfw" ${A}>November 21, 2026</a></blockquote>`,
    );
    expect(clean(tweet(`<p></p> — (@example_user) <a href="${POST}"></a>`))).toBe(
      `${marked(ID)}<p></p> — (@example_user) <a href="${POST}" ${A}></a></blockquote>`,
    );
    expect(clean(tweet(`<p><a href="${POST}">投稿の説明</a></p>`))).toBe(
      `${marked(ID)}<p><a href="${POST}" ${A}>投稿の説明</a></p></blockquote>`,
    );
    expect(clean(tweet(`<a href="${POST}"></a>`))).toBe(
      `${marked(ID)}<a href="${POST}" ${A}></a></blockquote>`,
    );
  });

  it("x.com と twitter.com、クエリ付き、ID が 1 桁と 20 桁、末尾の / で、印を付ける", () => {
    for (const [href, id] of [
      ["https://twitter.com/example_user/status/42", "42"],
      ["https://x.com/a/status/7?ref_src=twsrc%5Etfw&s=20", "7"],
      ["https://x.com/a/status/1", "1"],
      ["https://x.com/a/status/12345678901234567890", "12345678901234567890"],
      ["https://x.com/a/status/5/", "5"],
      ["https://X.COM/a/status/5#top", "5"],
      ["//twitter.com/a/status/5", "5"],
      ["https://x.com/abcdefghij_1234/status/5", "5"],
    ]) {
      expect(clean(tweet(`<a href="${href}">投稿</a>`)), href).toContain(marked(id as string));
    }
  });

  it("印を付けない：class がない、投稿のリンクがない、別の投稿のリンクが 2 つ、条件に合わないリンク", () => {
    const unmarked = (html: string) => expect(clean(html), html).toMatch(/^<blockquote>/);
    unmarked(`<blockquote><a href="${POST}">投稿</a></blockquote>`);
    unmarked(`<blockquote class="twitter-tweets"><a href="${POST}">投稿</a></blockquote>`);
    unmarked(tweet("<p>文だけ</p>"));
    unmarked(tweet('<a href="https://x.com/example_user">プロフィール</a>'));
    unmarked(tweet(`<a href="${POST}">1</a><a href="https://x.com/other/status/2">2</a>`));
    for (const href of [
      `http://x.com/a/status/${ID}`,
      `https://x.com:8443/a/status/${ID}`,
      `https://user:pass@x.com/a/status/${ID}`,
      `https://x.com.example.com/a/status/${ID}`,
      `https://example.com/x.com/a/status/${ID}`,
      `https://mobile.twitter.com/a/status/${ID}`,
      `https://www.x.com/a/status/${ID}`,
      `https://x.com/i/web/status/${ID}`,
      "https://x.com/a/status/123456789012345678901",
      "https://x.com/a/status/12a",
      "https://x.com/a/status/",
      "https://x.com/abcdefghij_12345/status/5",
      "https://x.com/a-b/status/5",
      "https://x.com/a/statuses/5",
      "https://x.com/a/status/5/photo/1",
    ]) {
      unmarked(tweet(`<a href="${href}">投稿</a>`));
    }
  });

  it("同じ ID を指すリンクが 2 つなら、印を付ける", () => {
    expect(
      clean(
        tweet(
          `<p><a href="https://twitter.com/a/status/${ID}">説明</a></p>` +
            `<a href="${POST}?ref_src=twsrc%5Etfw">日付</a>`,
        ),
      ),
    ).toMatch(new RegExp(`^${marked(ID)}`));
  });

  it("数えるのは、出力に残るリンク：落ちる要素の中は数えず、埋め込みを替えたリンクは数える", () => {
    expect(clean(tweet(`<noscript><a href="${POST}">投稿</a></noscript>`))).toBe(
      "<blockquote></blockquote>",
    );
    expect(clean(tweet(`<a>${ID}</a><a href="javascript:alert(1)">投稿</a>`))).toMatch(
      /^<blockquote>/,
    );
    expect(clean(tweet(`<iframe src="${POST}"></iframe>`))).toBe(
      `${marked(ID)}<a href="${POST}" ${A}>${POST}</a></blockquote>`,
    );
    const two = tweet(`<a href="${POST}">投稿</a><iframe src="https://x.com/b/status/2"></iframe>`);
    expect(clean(two)).toMatch(/^<blockquote>/);
    expect(clean(clean(two))).toBe(clean(two));
  });

  it("動画・音声と embed を替えたリンクも数え、2 回通しても変わらない", () => {
    for (const html of [
      tweet(`<video><source src="${POST}"></video>`),
      tweet(`<embed src="${POST}" />`),
      tweet(`<audio src="${POST}"></audio>`),
    ]) {
      const once = clean(html);
      expect(once, html).toBe(`${marked(ID)}<a href="${POST}" ${A}>${POST}</a></blockquote>`);
      expect(clean(once)).toBe(once);
    }
  });

  it("既定のポート（:443）は、絶対の URL にしたあとでは残らないので、印を付ける", () => {
    expect(clean(tweet(`<a href="https://x.com:443/a/status/${ID}">投稿</a>`))).toBe(
      `${marked(ID)}<a href="${POST.replace("example_user", "a")}" ${A}>投稿</a></blockquote>`,
    );
  });

  it("深さの上限のところで替えたリンクは数えない（2 回目に落ちるので、印が変わらない）", () => {
    const deep = (inner: string) => tweet(`${"<div>".repeat(99)}${inner}`);
    const once = clean(deep(`<iframe src="${POST}"></iframe>`));
    expect(once).toMatch(/^<blockquote>/);
    expect(clean(clean(once))).toBe(clean(once));
    // 上限より浅いところのリンクは数える
    const shallow = clean(tweet(`${"<div>".repeat(98)}<a href="${POST}">投稿</a>`));
    expect(shallow).toMatch(new RegExp(`^${marked(ID)}`));
    expect(clean(shallow)).toBe(shallow);
  });

  it("閉じタグの順が乱れていても、引用の中のリンクで付け、2 回通しても変わらない", () => {
    const once = clean(
      `<blockquote class="twitter-tweet"><p><a href="${POST}">投稿</blockquote></p><p>続き</p>`,
    );
    expect(once).toBe(
      `${marked(ID)}<p><a href="${POST}" ${A}>投稿</a></p></blockquote><p>続き</p>`,
    );
    expect(clean(once)).toBe(once);
  });

  it("入力に書かれた印は、引用の中のリンクの ID で付け直す。条件に合わなければ落とす", () => {
    for (const value of ["999", "abc", "", `${ID}" onclick="alert(1)`]) {
      expect(
        clean(
          `<blockquote data-x-post="${value.replaceAll('"', "&quot;")}"><a href="${POST}">投稿</a></blockquote>`,
        ),
      ).toBe(`${marked(ID)}<a href="${POST}" ${A}>投稿</a></blockquote>`);
    }
    expect(clean('<blockquote data-x-post="999"><p>文だけ</p></blockquote>')).toBe(
      "<blockquote><p>文だけ</p></blockquote>",
    );
    expect(
      clean(
        `<blockquote data-x-post="${ID}"><a href="${POST}">1</a><a href="https://x.com/b/status/2">2</a></blockquote>`,
      ),
    ).toMatch(/^<blockquote>/);
    expect(clean(`<blockquote data-x-post><a href="${POST}">投稿</a></blockquote>`)).toMatch(
      new RegExp(`^${marked(ID)}`),
    );
  });

  it("blockquote でない要素の印は落とす", () => {
    expect(clean(`<p data-x-post="${ID}"><a href="${POST}">投稿</a></p>`)).toBe(
      `<p><a href="${POST}" ${A}>投稿</a></p>`,
    );
    expect(clean(`<div data-x-post="${ID}" class="twitter-tweet">文</div>`)).toBe("<div>文</div>");
  });

  it("入れ子の引用：中のリンクは外側でも数え、内側はそれ自身でも調べる", () => {
    const inner = tweet('<a href="https://x.com/b/status/2">2</a>');
    // 外側は ID が 2 つになるので付けない。内側には付ける
    expect(clean(tweet(`<a href="${POST}">1</a>${inner}`))).toBe(
      `<blockquote><a href="${POST}" ${A}>1</a>` +
        `${marked("2")}<a href="https://x.com/b/status/2" ${A}>2</a></blockquote></blockquote>`,
    );
    // 内側が X の引用でなくても、中のリンクは外側で数える
    expect(clean(tweet(`<blockquote><a href="${POST}">引用</a></blockquote>`))).toBe(
      `${marked(ID)}<blockquote><a href="${POST}" ${A}>引用</a></blockquote></blockquote>`,
    );
    // 外側の引用の外にあるリンクは数えない
    expect(clean(`<blockquote>${inner}<a href="${POST}">外</a></blockquote>`)).toBe(
      `<blockquote>${marked("2")}<a href="https://x.com/b/status/2" ${A}>2</a></blockquote>` +
        `<a href="${POST}" ${A}>外</a></blockquote>`,
    );
  });

  it("閉じていない引用や、続く引用に、状態が漏れない", () => {
    // 閉じていない引用は、外の要素が閉じるところで閉じる。そのあとのリンクは数えない
    expect(
      clean(
        `<div>${tweet(`<a href="${POST}">1</a>`).replace("</blockquote>", "")}</div>` +
          '<p><a href="https://x.com/b/status/2">2</a></p>',
      ),
    ).toBe(
      `<div>${marked(ID)}<a href="${POST}" ${A}>1</a></blockquote></div>` +
        `<p><a href="https://x.com/b/status/2" ${A}>2</a></p>`,
    );
    // 最後まで閉じていない引用も、終わりで閉じて調べる
    expect(clean(`<blockquote class="twitter-tweet"><a href="${POST}">1</a>`)).toBe(
      `${marked(ID)}<a href="${POST}" ${A}>1</a></blockquote>`,
    );
    // 続く引用は、それぞれ別に数える。ふつうの引用は付けない
    expect(
      clean(
        tweet(`<a href="${POST}">1</a>`) +
          '<blockquote><a href="https://x.com/c/status/3">3</a></blockquote>' +
          tweet('<a href="https://x.com/b/status/2">2</a>'),
      ),
    ).toBe(
      `${marked(ID)}<a href="${POST}" ${A}>1</a></blockquote>` +
        `<blockquote><a href="https://x.com/c/status/3" ${A}>3</a></blockquote>` +
        `${marked("2")}<a href="https://x.com/b/status/2" ${A}>2</a></blockquote>`,
    );
  });

  it("Imgur の公式埋め込みと並んでも、互いの状態が漏れない", () => {
    const imgur =
      '<blockquote class="imgur-embed-pub"><a href="https://i.imgur.com/abc123.jpg">写真</a></blockquote>';
    expect(clean(imgur + tweet(`<a href="${POST}">投稿</a>`) + imgur)).toBe(
      `<blockquote><a href="https://i.imgur.com/abc123.jpg" ${A}>写真</a>` +
        '<img src="https://i.imgur.com/abc123.jpg"></blockquote>' +
        `${marked(ID)}<a href="${POST}" ${A}>投稿</a></blockquote>` +
        `<blockquote><a href="https://i.imgur.com/abc123.jpg" ${A}>写真</a>` +
        '<img src="https://i.imgur.com/abc123.jpg"></blockquote>',
    );
    // 同じ引用に両方の class があれば、両方を当てる
    const both = clean(
      `<blockquote class="imgur-embed-pub twitter-tweet"><a href="https://i.imgur.com/abc123.jpg">写真</a><a href="${POST}">投稿</a></blockquote>`,
    );
    expect(both).toBe(
      `${marked(ID)}<a href="https://i.imgur.com/abc123.jpg" ${A}>写真</a>` +
        `<a href="${POST}" ${A}>投稿</a><img src="https://i.imgur.com/abc123.jpg"></blockquote>`,
    );
    expect(clean(both)).toBe(both);
    // Imgur の引用の中の投稿のリンクには、印を付けない（twitter-tweet でないので）
    expect(
      clean(`<blockquote class="imgur-embed-pub"><a href="${POST}">投稿</a></blockquote>`),
    ).toBe(`<blockquote><a href="${POST}" ${A}>投稿</a></blockquote>`);
  });

  it("2 回通しても、印も値も変わらない", () => {
    const once = clean(
      tweet(`<p>文</p>&mdash; 名前 (@a) <a href="${POST}?ref_src=twsrc%5Etfw">日付</a>`) +
        tweet('<p><a href="https://twitter.com/b/status/2">説明</a></p>') +
        tweet(`<a href="${POST}">1</a><a href="https://x.com/b/status/2">2</a>`),
    );
    expect(once.match(/data-x-post="(\d+)"/g)).toEqual([`data-x-post="${ID}"`, 'data-x-post="2"']);
    expect(clean(once)).toBe(once);
  });

  it("返すとき（画像の差し替え）も、印を作り直して残す", async () => {
    const out = await sanitizeHtmlWithImages(
      `<blockquote data-x-post="999"><a href="${POST}">投稿</a><img src="https://img.example.com/a.png"></blockquote>`,
      BASE,
      async () => "/api/v1/images?x",
    );
    expect(out).toBe(
      `${marked(ID)}<a href="${POST}" ${A}>投稿</a><img src="/api/v1/images?x"></blockquote>`,
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

describe("Imgur の投稿のページを書いた公式埋め込み（findImgurPosts と、調べた画像を足すサニタイズ）", () => {
  const A = 'rel="noopener noreferrer nofollow"';
  const embed = (inner: string) =>
    `<blockquote class="imgur-embed-pub" lang="en" data-id="abc123">${inner}</blockquote>`;
  const posts = (html: string, base = BASE) => findImgurPosts(html, base);

  it("投稿・アルバム・ギャラリーのページを、絶対の URL にしたあとで、クエリとハッシュを除いて返す", () => {
    expect(
      posts(
        embed('<a href="//imgur.com/abc123"></a>') +
          embed('<a href="https://imgur.com/a/Alb1?x=1#y">アルバム</a>') +
          embed('<a href="https://imgur.com/gallery/Gal2"></a>'),
      ),
    ).toEqual([
      "https://imgur.com/abc123",
      "https://imgur.com/a/Alb1",
      "https://imgur.com/gallery/Gal2",
    ]);
    // 記事が http なら http（スキームは書き換えない）
    expect(posts(embed('<a href="//imgur.com/abc123"></a>'), "http://blog.example.com/1")).toEqual([
      "http://imgur.com/abc123",
    ]);
  });

  it("同じ URL は 1 つにまとめる。引用ごとに最初の 1 つ", () => {
    expect(
      posts(
        embed('<a href="//imgur.com/one1"></a><a href="//imgur.com/two2"></a>') +
          embed('<a href="https://imgur.com/one1?ref=x"></a>'),
      ),
    ).toEqual(["https://imgur.com/one1"]);
  });

  it("対象にならないもの", () => {
    for (const html of [
      // 直リンクの画像を足す引用（投稿のリンクが先にあっても）
      embed('<a href="//imgur.com/abc123"></a><a href="https://i.imgur.com/abc123.jpeg">写真</a>'),
      // サニタイズのあとに残る画像がある引用
      embed('<a href="//imgur.com/abc123"></a><img src="/a.png">'),
      // 公式埋め込みでない引用
      '<blockquote><a href="//imgur.com/abc123"></a></blockquote>',
      // 形の合わないリンク
      embed('<a href="https://imgur.com/t/funny/abc123"></a>'),
      embed('<a href="https://imgur.com/gallery/title-abc123"></a>'),
      embed('<a href="https://imgur.com/abc123/"></a>'),
      embed('<a href="https://imgur.com/"></a>'),
      embed('<a href="https://www.imgur.com/abc123"></a>'),
      embed('<a href="https://m.imgur.com/abc123"></a>'),
      embed('<a href="https://imgur.com:8443/abc123"></a>'),
      embed('<a href="https://user@imgur.com/abc123"></a>'),
      embed('<a href="mailto:a@imgur.com"></a>'),
    ]) {
      expect(posts(html), html).toEqual([]);
    }
    // サニタイズで落ちる画像（計測用）だけなら対象
    expect(
      posts(
        embed(
          '<a href="//imgur.com/abc123"></a><img src="https://pixel.example.com/t.gif" width="1" height="1">',
        ),
      ),
    ).toEqual(["https://imgur.com/abc123"]);
  });

  it("調べた画像を、引用の終わり（リンクの外）に 1 枚足す。調べた画像のない引用は変えない", () => {
    const html =
      embed('<p><a href="//imgur.com/abc123"></a></p>') + embed('<a href="//imgur.com/none9"></a>');
    const images = new Map([["https://imgur.com/abc123", "https://i.imgur.com/abc123.jpeg?fb"]]);
    expect(sanitizeHtml(html, BASE, { imgurPostImages: images })).toBe(
      `<blockquote><p><a href="https://imgur.com/abc123" ${A}>https://imgur.com/abc123</a></p>` +
        '<img src="https://i.imgur.com/abc123.jpeg?fb"></blockquote>' +
        `<blockquote><a href="https://imgur.com/none9" ${A}>https://imgur.com/none9</a></blockquote>`,
    );
  });

  it("同じ投稿の引用がいくつあっても、それぞれに足す。もう一度通しても増えない", () => {
    const html =
      embed('<a href="//imgur.com/abc123"></a>') + embed('<a href="//imgur.com/abc123?x"></a>');
    const images = new Map([["https://imgur.com/abc123", "https://i.imgur.com/abc123.jpeg"]]);
    const once = sanitizeHtml(html, BASE, { imgurPostImages: images });
    expect(once.match(/<img src="https:\/\/i\.imgur\.com\/abc123\.jpeg">/g)).toHaveLength(2);
    expect(clean(once)).toBe(once);
    expect(findImgurPosts(once, BASE)).toEqual([]);
  });

  it("直リンクの引用と、画像の残る引用には、調べた画像があっても足さない", () => {
    const images = new Map([["https://imgur.com/abc123", "https://i.imgur.com/other.jpeg"]]);
    const direct = embed(
      '<a href="//imgur.com/abc123"></a><a href="https://i.imgur.com/abc123.jpeg">写真</a>',
    );
    expect(sanitizeHtml(direct, BASE, { imgurPostImages: images })).toBe(clean(direct));
    const withImage = embed('<a href="//imgur.com/abc123"></a><img src="/a.png">');
    expect(sanitizeHtml(withImage, BASE, { imgurPostImages: images })).toBe(clean(withImage));
  });
});
