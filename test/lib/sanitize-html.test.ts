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
});

describe("hasMarkupBeyondText", () => {
  it("画像やリンクなどがあれば true、段落と強調だけなら false", () => {
    expect(hasMarkupBeyondText("<p>a<strong>b</strong></p><div>c</div>")).toBe(false);
    expect(hasMarkupBeyondText('<p><img src="https://img.example.com/a.png"></p>')).toBe(true);
    expect(hasMarkupBeyondText("<pre>x</pre>")).toBe(true);
    expect(hasMarkupBeyondText("<p>&lt;img src=x&gt;</p>")).toBe(false);
  });
});
