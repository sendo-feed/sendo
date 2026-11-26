import { describe, expect, it } from "vitest";
import {
  MAX_BELL_WORDS,
  MAX_BELL_WORDS_LENGTH,
  matchesBellWords,
  parseBellTarget,
  parseBellWords,
  toMatchText,
} from "../../src/notify/words";

/*
 * ベルの言葉の受け方と当て方（docs/decisions/notifications.md の 6、7）。
 */

/** 言葉を受けて、記事の文字に当たるか */
function matches(words: string, text: string): boolean {
  const parsed = parseBellWords(words);
  if (typeof parsed === "string") throw new Error(parsed);
  return matchesBellWords(toMatchText(text), parsed.matchKey);
}

describe("言葉を受ける", () => {
  it("NFKC にしてから空白の並び（全角の空白、タブ、改行を含む）で区切り、半角の空白 1 つでつなぐ", () => {
    expect(parseBellWords("  Azure\u3000障害\t\n Ｇｏ  ")).toEqual({
      words: "Azure 障害 Go",
      matchKey: "azure go 障害",
    });
  });

  it("小文字にして同じになる言葉は最初のものだけを残し、大文字と小文字は入れたまま残す", () => {
    expect(parseBellWords("AWS aws Aws ＡＷＳ Lambda")).toEqual({
      words: "AWS Lambda",
      matchKey: "aws lambda",
    });
  });

  it("照合用の言葉は、並びや大文字と小文字によらず同じになる", () => {
    const keys = ["Azure 障害", "障害 azure", "AZURE\u3000障害 Azure"].map(
      (words) => (parseBellWords(words) as { matchKey: string }).matchKey,
    );
    expect(new Set(keys)).toEqual(new Set(["azure 障害"]));
  });

  it("照合用の言葉は、UTF-16 の単位ではなくコードポイントの順に並べる", () => {
    // UTF-16 の単位では U+1F600 の上位サロゲート（U+D83D）が U+E000 より先、コードポイントでは
    // U+E000 が先
    const parsed = parseBellWords("\u{1F600} \uE000");
    expect(parsed).toMatchObject({ matchKey: "\uE000 \u{1F600}" });
  });

  it("引用符も言葉の文字として扱う", () => {
    expect(parseBellWords('"Azure 障害"')).toEqual({
      words: '"Azure 障害"',
      matchKey: '"azure 障害"',
    });
  });

  it(`言葉は ${MAX_BELL_WORDS} 個まで。重なりを除く前に ${MAX_BELL_WORDS + 1} 個でも、除いたあと ${MAX_BELL_WORDS} 個なら受ける`, () => {
    const eight = Array.from({ length: MAX_BELL_WORDS }, (_, i) => `w${i}`);
    expect(parseBellWords(eight.join(" "))).toMatchObject({ words: eight.join(" ") });
    expect(parseBellWords([...eight, "W0"].join(" "))).toMatchObject({ words: eight.join(" ") });
    expect(parseBellWords([...eight, "w8"].join(" "))).toBe("too_many_words");
  });

  it(`全体で ${MAX_BELL_WORDS_LENGTH} 文字（区切りの空白を含むコードポイントの数）まで。重なりを除いた形で数える`, () => {
    // 区切りの空白 1 つを含めて 64 文字。絵文字はサロゲートの組でも 1 文字
    const exact = `${"あ".repeat(31)} ${"\u{1F600}".repeat(32)}`;
    expect(Array.from(exact)).toHaveLength(MAX_BELL_WORDS_LENGTH);
    expect(parseBellWords(exact)).toMatchObject({ words: exact });
    expect(parseBellWords(`${exact}い`)).toBe("too_long");
    // 重なりを除く前は 64 文字を超えるが、除いたあとは 64 文字
    expect(parseBellWords(`${exact} ${"あ".repeat(31)}`)).toMatchObject({ words: exact });
    // 余分な空白は数えない
    expect(parseBellWords(`\u3000${exact.replace(" ", "\t\t\t")}  `)).toMatchObject({
      words: exact,
    });
  });

  it("受ける文字列の長さでは断らない。区切ったあとの言葉が上限に収まれば受ける", () => {
    expect(parseBellWords(`Rust${" ".repeat(1021)}`)).toMatchObject({ words: "Rust" });
  });

  it("NFKC で長くなる文字は、長くなったあとの形で数える", () => {
    // 「㍿」は NFKC で「株式会社」（4 文字）になる
    expect(parseBellWords(`${"あ".repeat(60)}㍿`)).toMatchObject({
      words: `${"あ".repeat(60)}株式会社`,
    });
    expect(parseBellWords(`${"あ".repeat(61)}㍿`)).toBe("too_long");
  });

  it("空と、空白だけは受けない", () => {
    for (const words of ["", " ", "\u3000\t\n"]) expect(parseBellWords(words)).toBe("empty");
  });

  it("制御文字と、対になっていないサロゲートを含む言葉は受けない", () => {
    for (const words of ["Azure\u0000", "a\u001fb", "\u007f", "\u0085障害", "\ud800", "a\udc00"]) {
      expect(parseBellWords(words), JSON.stringify(words)).toBe("invalid_character");
    }
  });
});

describe("付けるベルの組", () => {
  it("feedId と words のどちらか一方があれば組にし、どちらもなければ missing", () => {
    const words = { words: "障害", matchKey: "障害" };
    expect(parseBellTarget({ feedId: "f" })).toEqual({ feedId: "f", words: null });
    expect(parseBellTarget({ words: "障害" })).toEqual({ feedId: null, words });
    expect(parseBellTarget({ feedId: "f", words: "障害" })).toEqual({ feedId: "f", words });
    expect(parseBellTarget({})).toBe("missing");
    expect(parseBellTarget({ feedId: "f", words: " " })).toBe("empty");
  });
});

describe("言葉を当てる", () => {
  it("すべての言葉を含む記事に当てる（AND）", () => {
    expect(matches("Azure 障害", "Azure で大きな障害")).toBe(true);
    expect(matches("Azure 障害", "Azure の新機能")).toBe(false);
    expect(matches("Azure 障害", "AWS で障害")).toBe(false);
  });

  it("大文字と小文字、全角と半角の英数字を区別しない", () => {
    expect(matches("Azure", "azure の障害")).toBe(true);
    expect(matches("azure", "AZURE の障害")).toBe(true);
    expect(matches("Azure", "Ａｚｕｒｅ の障害")).toBe(true);
    expect(matches("Ａｚｕｒｅ", "azure の障害")).toBe(true);
    expect(matches("2026", "２０２６年")).toBe(true);
  });

  it("英数字の端では、すぐ前やすぐあとに英数字があると当てない", () => {
    expect(matches("Go", "Google の新しい発表")).toBe(false);
    expect(matches("Go", "Go 1.26 が出た")).toBe(true);
    expect(matches("Go", "Go言語の話")).toBe(true);
    expect(matches("Go", "新しいGo")).toBe(true);
    expect(matches("Go", "Golang と Go")).toBe(true);
    expect(matches("Go", "ＧＯＯＧＬＥ")).toBe(false);
    expect(matches("Go", "go-lang")).toBe(true);
    expect(matches("AI", "said")).toBe(false);
    expect(matches("1.26", "Go 1.26")).toBe(true);
    expect(matches("1.2", "Go 1.26")).toBe(false);
  });

  it("日本語や記号の端では、前後を見ない", () => {
    expect(matches("障害", "大規模障害が起きた")).toBe(true);
    expect(matches("障害", "障害物")).toBe(true);
    expect(matches("C#", "C#er")).toBe(true);
    expect(matches("#rust", "a#rust")).toBe(true);
  });

  it("引用符も文字として当てる", () => {
    expect(matches('"障害"', "「障害」")).toBe(false);
    expect(matches('"障害"', 'これは "障害" です')).toBe(true);
  });

  it("前の箇所が区切りで当たらなくても、あとの箇所で当てる", () => {
    expect(matches("rust", "rusty だが rust でもある")).toBe(true);
  });
});
