import { describe, expect, it } from "vitest";
import { stripTags, tokenizeHtml } from "../../src/lib/html";

const tags = (html: string) =>
  [...tokenizeHtml(html)].flatMap((token) =>
    token.type === "tag" ? [`${token.closing ? "/" : ""}${token.name}`] : [],
  );

describe("tokenizeHtml", () => {
  it("引用符で囲んだ属性の値の中の「>」ではタグを閉じない", () => {
    expect(stripTags("<a title=\"x > y\" data-x='>'>link</a>")).toBe(" link ");
  });

  it("引用符で囲んでいない値の「'」は、引用符の始まりとみなさない", () => {
    expect(stripTags("<a title=don't>x</a>")).toBe(" x ");
  });

  it("コメントと script ／ style ／ template ／ noscript の中は、タグとして読まない", () => {
    expect(
      tags(`<!-- <link a> --><script>var s = "<link b>";</script><style>a{}</style>
        <template><link c></template><noscript><link d></noscript><link e>`),
    ).toEqual([
      "script",
      "/script",
      "style",
      "/style",
      "template",
      "/template",
      "noscript",
      "/noscript",
      "link",
    ]);
  });

  it("閉じていないタグ・コメント・引用符に当たったら、そこでやめる", () => {
    expect(stripTags("a <b c")).toBe("a ");
    expect(stripTags("a <!-- b")).toBe("a ");
    expect(stripTags('a <b title="c>d')).toBe("a ");
    expect(stripTags("a <script> b")).toBe("a  ");
  });

  // 二乗の時間がかかる実装だと、どれもテストの制限時間（5 秒）を大きく超える
  it.each([
    ["閉じていないタグ", "<a".repeat(300_000)],
    ["閉じていない引用符", '<a b="'.repeat(200_000)],
    ["引用符の続く属性", `<a ${'b=">" '.repeat(200_000)}`],
    ["閉じていない script", "<script>".repeat(200_000)],
    ["閉じていないコメント", "<!--".repeat(300_000)],
  ])("悪意のある入力でも長さに比例する時間で終わる：%s", (_label, html) => {
    expect(typeof stripTags(html)).toBe("string");
  });
});
