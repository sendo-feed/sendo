import { describe, expect, it } from "vitest";
import { createLanguageDetector, loadNativeModule } from "../../../src/platform/node/native";
import { NATIVE_MODULE } from "../../db";

const JA =
  "記事の言語を調べるときは、タイトルだけでなく本文も確認します。英語の製品名が含まれていても、日本語で書かれた説明文を英語の記事として扱わないことが大切です。判定が難しい場合は、結果を確定せずに保留します。";
const EN =
  "The application stores each article once and shares the original text across readers. A translation should be created only when the reader needs another language. The original article must remain available after translation.";

describe("言語判定のネイティブモジュール", () => {
  const detector = createLanguageDetector(loadNativeModule(NATIVE_MODULE));

  it("版を返し、スレッドプールから同じ判定器を並行して利用できる", async () => {
    expect(detector).toMatchObject({ detector: "lingua-1.8.0-high-all75", pipelineRevision: 1 });
    const results = await Promise.all(
      [EN, JA, EN, JA].map((text) => detector.detect(`<p>${text}</p>`)),
    );
    expect(results.map((r) => r.language)).toEqual(["en", "ja", "en", "ja"]);
    expect(
      results.every((r) => r.status === "detected" && /^[a-f0-9]{64}$/.test(r.inputHash)),
    ).toBe(true);
    expect(results[0]?.inputHash).toBe(results[2]?.inputHash);
  });

  it("コードの除外・短文の保留・入力上限をJSからも利用できる", async () => {
    expect(await detector.detect(`<p>${JA}</p><pre>${EN.repeat(100)}</pre>`)).toMatchObject({
      language: "ja",
      status: "detected",
    });
    expect(await detector.detect("Rust")).toMatchObject({
      language: "und",
      status: "insufficient",
    });
    await expect(detector.detect("x".repeat(256 * 1024 + 1))).rejects.toThrow("256 KiB");
  });
});
