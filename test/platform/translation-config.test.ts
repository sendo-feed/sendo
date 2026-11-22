import { describe, expect, it } from "vitest";
import { readTranslationConfig } from "../../src/platform/config";

describe("記事の翻訳の設定（docs/decisions/translation.md の 9、15）", () => {
  it("API キーがなければ、翻訳は動かない", () => {
    expect(readTranslationConfig({})).toBeUndefined();
    expect(
      readTranslationConfig({ ANTHROPIC_API_KEY: "  ", TRANSLATION_MODEL: "x" }),
    ).toBeUndefined();
  });

  it("TRANSLATION_MODEL があればそのモデルに固定し、なければ固定しない（Models API で選ぶ）", () => {
    expect(
      readTranslationConfig({ ANTHROPIC_API_KEY: "sk", TRANSLATION_MODEL: " claude-sonnet-4-5 " }),
    ).toEqual({
      apiKey: "sk",
      model: "claude-sonnet-4-5",
    });
    expect(readTranslationConfig({ ANTHROPIC_API_KEY: "sk" })).toEqual({ apiKey: "sk" });
    expect(readTranslationConfig({ ANTHROPIC_API_KEY: "sk", TRANSLATION_MODEL: " " })).toEqual({
      apiKey: "sk",
    });
  });

  it("RETRANSLATION_MODEL があれば訳し直しのモデルを固定し、その場の翻訳のモデルとは別に決める", () => {
    expect(
      readTranslationConfig({ ANTHROPIC_API_KEY: "sk", RETRANSLATION_MODEL: " claude-opus-4-5 " }),
    ).toEqual({ apiKey: "sk", retranslationModel: "claude-opus-4-5" });
    expect(
      readTranslationConfig({
        ANTHROPIC_API_KEY: "sk",
        TRANSLATION_MODEL: "claude-sonnet-4-5",
        RETRANSLATION_MODEL: " ",
      }),
    ).toEqual({ apiKey: "sk", model: "claude-sonnet-4-5" });
  });
});
