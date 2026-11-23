import { afterEach, describe, expect, it, vi } from "vitest";
import { readTranslationConfig, type TranslationEnvName } from "../../src/platform/config";

const read = (env: Partial<Record<TranslationEnvName, string>>) =>
  readTranslationConfig({ ANTHROPIC_API_KEY: "sk", ...env });

describe("記事の翻訳の設定（docs/decisions/translation.md の 9、15）", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("API キーがなければ、翻訳は動かない", () => {
    expect(readTranslationConfig({})).toBeUndefined();
    expect(
      readTranslationConfig({ ANTHROPIC_API_KEY: "  ", TRANSLATION_MODEL: "x" }),
    ).toBeUndefined();
  });

  it("設定がなければ、通常は Sonnet・medium、長文は Haiku・low（3,000 文字）、品質優先は Opus・medium", () => {
    const expected = {
      apiKey: "sk",
      normal: { model: { family: "sonnet" }, effort: "medium" },
      long: { model: { family: "haiku" }, effort: "low" },
      quality: { model: { family: "opus" }, effort: "medium" },
      longThresholdChars: 3000,
    };
    expect(read({})).toEqual(expected);
    // 空の値は、書いていないものとする
    expect(
      read({
        TRANSLATION_MODEL: " ",
        TRANSLATION_EFFORT: "",
        TRANSLATION_LONG_MODEL: " ",
        TRANSLATION_LONG_EFFORT: " ",
        TRANSLATION_LONG_THRESHOLD_CHARS: " ",
        RETRANSLATION_MODEL: "",
        RETRANSLATION_EFFORT: " ",
      }),
    ).toEqual(expected);
  });

  it("段階ごとに、モデル（系列の名前は大文字と小文字を区別しない。claude- で始まれば ID）と思考量を変えられる", () => {
    expect(
      read({
        TRANSLATION_MODEL: " Haiku ",
        TRANSLATION_EFFORT: "HIGH",
        TRANSLATION_LONG_MODEL: "claude-haiku-4-5",
        TRANSLATION_LONG_EFFORT: "medium",
        TRANSLATION_LONG_THRESHOLD_CHARS: " 5000 ",
        RETRANSLATION_MODEL: " claude-opus-4-5 ",
        RETRANSLATION_EFFORT: "Max",
      }),
    ).toEqual({
      apiKey: "sk",
      normal: { model: { family: "haiku" }, effort: "high" },
      long: { model: { id: "claude-haiku-4-5" }, effort: "medium" },
      quality: { model: { id: "claude-opus-4-5" }, effort: "max" },
      longThresholdChars: 5000,
    });
    expect(read({ TRANSLATION_EFFORT: "xhigh" })?.normal.effort).toBe("xhigh");
    expect(read({ TRANSLATION_LONG_EFFORT: "low" })?.long.effort).toBe("low");
  });

  it("閾値は 1 から 60,000 まで受け付ける", () => {
    expect(read({ TRANSLATION_LONG_THRESHOLD_CHARS: "1" })?.longThresholdChars).toBe(1);
    expect(read({ TRANSLATION_LONG_THRESHOLD_CHARS: "60000" })?.longThresholdChars).toBe(60000);
  });

  it("知らない系列の名前、知らない思考量、範囲の外の閾値は、エラーをログに出して、その項目だけ既定で動く", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const config = read({
      TRANSLATION_MODEL: "gpt",
      TRANSLATION_EFFORT: "medium",
      TRANSLATION_LONG_MODEL: "opus",
      TRANSLATION_LONG_EFFORT: "none",
      RETRANSLATION_MODEL: "sonnet-5",
      RETRANSLATION_EFFORT: "extreme",
      TRANSLATION_LONG_THRESHOLD_CHARS: "0",
    });
    expect(config).toEqual({
      apiKey: "sk",
      normal: { model: { family: "sonnet" }, effort: "medium" },
      long: { model: { family: "opus" }, effort: "low" },
      quality: { model: { family: "opus" }, effort: "medium" },
      longThresholdChars: 3000,
    });
    // 誤った項目ごとに 1 回
    expect(error).toHaveBeenCalledTimes(5);
    for (const name of [
      "TRANSLATION_MODEL",
      "TRANSLATION_LONG_EFFORT",
      "RETRANSLATION_MODEL",
      "RETRANSLATION_EFFORT",
      "TRANSLATION_LONG_THRESHOLD_CHARS",
    ]) {
      expect(error).toHaveBeenCalledWith(expect.stringContaining(name));
    }
    for (const value of ["60001", "abc", "1.5", "-1", "3e3"]) {
      expect(read({ TRANSLATION_LONG_THRESHOLD_CHARS: value })?.longThresholdChars).toBe(3000);
    }
  });
});
