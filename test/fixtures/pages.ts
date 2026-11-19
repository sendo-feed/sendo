/** Readability が本文だと判断できる、ある程度の長さのページ */
export function articlePage(options: { charsetMeta?: string; script?: boolean } = {}): string {
  const paragraphs = Array.from(
    { length: 8 },
    (_, i) =>
      `<p>これは記事の本文の段落 ${i} です。本文だと判断できるように、ある程度の長さの文章を、いくつかの段落に分けて書いておきます。<a href="/related/${i}">関連</a></p>`,
  ).join("");
  return [
    "<!doctype html><html><head>",
    options.charsetMeta ? `<meta charset="${options.charsetMeta}">` : "",
    "<title>見出し | サイト</title></head><body><nav>メニュー</nav><article><h1>見出し</h1>",
    paragraphs,
    options.script ? "<script>alert(1)</script><img src=x onerror=alert(1)>" : "",
    "</article><footer>フッター</footer></body></html>",
  ].join("");
}
