import { describe, expect, it } from "vitest";
import { sanitizeHtml } from "../../src/lib/sanitize-html";
import { splitBody } from "../../src/translation/segments";

/** 本文の断片分けと組み立て（docs/decisions/translation.md の 10） */

const html = (raw: string) => sanitizeHtml(raw, "https://example.com/post");

describe("splitBody", () => {
  it("文字を直接持つブロックごとに断片にし、リンク・強調・画像・コードを印に替える", () => {
    const body = splitBody(
      html(
        '<h2>Intro</h2><p>Read <a href="https://example.com/a">the <em>guide</em></a> and run <code>npm i</code>.<br><img src="https://example.com/i.png" alt="diagram"></p><pre><code>const x = 1;</code></pre>',
      ),
    );
    expect(body.segments).toEqual([
      { id: "b1", text: "Intro" },
      { id: "b2", text: "Read ⟦1⟧the ⟦2⟧guide⟦/2⟧⟦/1⟧ and run ⟦3/⟧.⟦4/⟧⟦5/⟧" },
    ]);
    const sent = JSON.stringify(body.segments);
    // URL と pre ／ code の中身は送らない
    expect(sent).not.toContain("example.com");
    expect(sent).not.toContain("npm i");
    expect(sent).not.toContain("const x");
    expect(sent).not.toContain("<");
  });

  it("訳を組み立てると、ブロックの並びと、リンク・画像・コードの位置と中身を保つ", () => {
    const source = html(
      '<p>Read <a href="https://example.com/a">the <em>guide</em></a> and run <code>npm i</code>.</p><pre>keep</pre>',
    );
    const body = splitBody(source);
    const out = body.assemble(new Map([["b1", "⟦1⟧⟦2⟧ガイド⟦/2⟧を⟦/1⟧読み、⟦3/⟧ を実行する。"]]));
    // リンクの開きタグ（サニタイズが付けた属性も）はそのまま戻す
    const link = /<a [^>]*>/.exec(source)?.[0];
    expect(link).toContain('href="https://example.com/a"');
    expect(out).toBe(
      `<p>${link}<em>ガイド</em>を</a>読み、<code>npm i</code> を実行する。</p><pre>keep</pre>`,
    );
  });

  it("リスト・表・引用・入れ子のブロックを、それぞれ別の断片にする", () => {
    const body = splitBody(
      html(
        "<ul><li>One<ul><li>Two</li></ul></li></ul><table><tr><th>A</th><td>B</td></tr></table><blockquote><p>Q</p></blockquote><figure><img src='https://example.com/x.png'><figcaption>Cap</figcaption></figure>",
      ),
    );
    expect(body.segments.map((s) => s.text)).toEqual(["One", "Two", "A", "B", "Q", "Cap"]);
    const translated = new Map(body.segments.map((s) => [s.id, `訳${s.text}`]));
    expect(body.assemble(translated)).toBe(
      '<ul><li>訳One<ul><li>訳Two</li></ul></li></ul><table><tr><th>訳A</th><td>訳B</td></tr></table><blockquote><p>訳Q</p></blockquote><figure><img src="https://example.com/x.png"><figcaption>訳Cap</figcaption></figure>',
    );
  });

  it.each([
    ["印が欠けた", "⟦1⟧ガイド を読む"],
    ["印が増えた", "⟦1⟧ガイド⟦/1⟧ ⟦3/⟧ を読む ⟦2/⟧"],
    ["同じ印が 2 回", "⟦1⟧ガ⟦/1⟧⟦1⟧イド⟦/1⟧ ⟦2/⟧"],
    ["入れ子が変わった", "⟦1⟧ガイド ⟦2/⟧⟦/1⟧"],
    ["閉じる順が違う", "⟦/1⟧ガイド⟦1⟧ ⟦2/⟧"],
    ["対になる印と単独の印を取り違えた", "⟦1/⟧ガイド ⟦2⟧⟦/2⟧"],
  ])("%s訳は使わず、その断片は原文のまま残す。ほかの断片は訳す", (_name, broken) => {
    const source = html('<p>Read <a href="https://example.com/a">guide</a> <br>now</p><p>Next</p>');
    const body = splitBody(source);
    expect(body.segments[0]?.text).toBe("Read ⟦1⟧guide⟦/1⟧ ⟦2/⟧now");
    const out = body.assemble(
      new Map([
        ["b1", broken],
        ["b2", "次"],
      ]),
    );
    expect(out).toBe(source.replace("<p>Next</p>", "<p>次</p>"));
  });

  it("同じ入れ子の中で印の順が変わるのは、訳の語順として受け入れる", () => {
    const source = html('<p><a href="https://example.com/a">A</a> and <em>B</em></p>');
    const body = splitBody(source);
    expect(body.segments[0]?.text).toBe("⟦1⟧A⟦/1⟧ and ⟦2⟧B⟦/2⟧");
    const out = body.assemble(new Map([["b1", "⟦2⟧B⟦/2⟧と⟦1⟧A⟦/1⟧"]]));
    const link = /<a [^>]*>/.exec(source)?.[0];
    expect(out).toBe(`<p><em>B</em>と${link}A</a></p>`);
  });

  it("文字が URL のリンクは、URL を送らず単独の印にする", () => {
    const source = html(
      '<p>See <a href="https://example.com/x">https://example.com/x</a> and <a href="https://example.com/y">www.example.com/y</a></p><iframe src="https://www.youtube.com/embed/abc"></iframe>',
    );
    const body = splitBody(source);
    const sent = JSON.stringify(body.segments);
    expect(sent).not.toContain("example.com");
    expect(sent).not.toContain("youtube");
    expect(body.segments[0]?.text).toBe("See ⟦1/⟧ and ⟦2/⟧");
    expect(body.assemble(new Map([["b1", "⟦1/⟧ と ⟦2/⟧ を見る"]]))).toContain(
      "https://example.com/x</a> と ",
    );
  });

  it("文の中の要素の中にあるブロックは別の断片にし、pre の中身は送らない", () => {
    const source = html(
      '<p><a href="https://example.com/a">Title<span><p>Inner</p></span></a></p><p><strong><pre>secret code</pre></strong> after</p>',
    );
    const body = splitBody(source);
    const sent = JSON.stringify(body.segments);
    expect(sent).not.toContain("secret code");
    expect(body.segments.map((segment) => segment.text)).toEqual(
      ["Title", "Inner", "after"].map((text) => expect.stringContaining(text) as unknown as string),
    );
    const translated = new Map(body.segments.map((s) => [s.id, `訳${s.text}`]));
    const out = body.assemble(translated);
    expect(out).toContain("<pre>secret code</pre>");
    expect(out).toContain("訳Title");
    expect(out).toContain("<p>訳Inner</p>");
  });

  it.each([
    ['<a href="https://github.com/foo/bar">github.com/foo/bar</a>', "github.com"],
    ['<a href="https://example.com/a">&lt;https://example.com/a&gt;</a>', "example.com"],
    ['<a href="https://example.com/a">\u2060https://example.com/a</a>', "example.com"],
    ['<a href="https://example.com/a">https://example.com/a b</a>', "example.com"],
    ['<a href="https://example.com/a">https://example.com <code>z</code></a>', "example.com"],
    ['<a href="mailto:someone@example.com">someone@example.com</a>', "someone@"],
    ['<a href="https://example.com/a">see<br>https://example.com/a</a>', "example.com"],
  ])("URL を見せるリンク %s は、URL を送らない", (link, hidden) => {
    const body = splitBody(html(`<p>Read ${link} now</p>`));
    expect(JSON.stringify(body.segments)).not.toContain(hidden);
    expect(body.segments[0]?.text).toBe("Read ⟦1/⟧ now");
  });

  it("中身を送らない要素は、中にブロックがあっても単独の印にする", () => {
    const body = splitBody(html("<p>A <code>c<pre>SECRET</pre></code> B</p>"));
    expect(JSON.stringify(body.segments)).not.toContain("SECRET");
    expect(body.segments[0]?.text).toBe("A ⟦1/⟧ B");
  });

  it("ブロックとして扱った文の中の要素は、開きタグと属性を保ち、2 段下のブロックも別の断片にする", () => {
    const source = html(
      '<p><a href="https://example.com/a">Title<p>Inner</p></a></p><div><strong><em><p>Deep</p></em></strong></div>',
    );
    const body = splitBody(source);
    expect(body.segments.map((segment) => segment.text)).toEqual(["Title", "Inner", "Deep"]);
    const out = body.assemble(new Map(body.segments.map((s) => [s.id, `訳${s.text}`])));
    const link = /<a [^>]*>/.exec(source)?.[0];
    expect(link).toContain('href="https://example.com/a"');
    expect(out).toContain(`${link}訳Title<p>訳Inner</p></a>`);
    expect(out).toContain("<strong><em><p>訳Deep</p></em></strong>");
  });

  it("中身のない要素は単独の印にする（落とされても断片を原文に戻さない）", () => {
    const body = splitBody(html("<p>Hello <em></em>world</p>"));
    expect(body.segments[0]?.text).toBe("Hello ⟦1/⟧world");
  });

  it("返ってこなかった断片は原文のまま残す", () => {
    const body = splitBody(html("<p>One</p><p>Two</p>"));
    expect(body.assemble(new Map([["b2", "二"]]))).toBe("<p>One</p><p>二</p>");
  });

  it("訳の中のタグの文字列は、要素にならず文字として残る", () => {
    const body = splitBody(html("<p>Hello</p>"));
    expect(
      body.assemble(new Map([["b1", '<script>alert(1)</script><img src=x onerror="y">']])),
    ).toBe("<p>&lt;script&gt;alert(1)&lt;/script&gt;&lt;img src=x onerror=&quot;y&quot;&gt;</p>");
  });

  it("文字のないブロック、空白だけの並び、印の文字を含む断片は送らない", () => {
    const body = splitBody(
      html("<p> </p><p><img src='https://example.com/a.png'></p><p>a ⟦1⟧ b</p>"),
    );
    expect(body.segments).toEqual([]);
    expect(body.length).toBe(0);
  });

  it("送る文の長さを Unicode の文字で数える", () => {
    const body = splitBody(html("<p>😀a</p><p>bc</p>"));
    expect(body.length).toBe(4);
  });
});
