import { describe, expect, it } from "vitest";
import { createArticleAnalyzer, loadNativeModule } from "../../../src/platform/node/native";
import { NATIVE_MODULE } from "../../db";

/**
 * 記事の解析のネイティブモジュール（docs/decisions/article-analysis.md）。本物の埋め込みのモデル（130MB）は
 * テストでは読み込まない。埋め込みの流れは Rust のテスト（crates/analysis）が小さなモデルで確かめる
 */
describe("記事の解析のネイティブモジュール", () => {
  const native = loadNativeModule(NATIVE_MODULE);

  it("版と次元を返す", () => {
    expect(native.analysisInfo()).toEqual({
      candidateRevision: 1,
      embeddingRevision: 1,
      dimension: 256,
    });
  });

  it("候補の語だけなら、モデルを読み込まずにスレッドプールで作れる", async () => {
    const result = await native.analyzeArticle({
      title: "In Rust と Claude Code の話",
      summary: "<p>Java 8 と k8s</p>",
      html: "<p>コンテナ・オーケストレーション</p><pre>document.addEventListener</pre>",
      categories: ["AI", " 2024 "],
      candidates: true,
      embedding: false,
    });
    expect(result.embedding ?? undefined).toBeUndefined();
    expect(result.candidates).toEqual([
      { surface: "AI", key: "ai", source: "category" },
      { surface: "Rust", key: "rust", source: "text" },
      { surface: "Claude Code", key: "claude code", source: "text" },
      { surface: "Java", key: "java", source: "text" },
      { surface: "k8s", key: "k8s", source: "text" },
      { surface: "コンテナ", key: "コンテナ", source: "text" },
      { surface: "オーケストレーション", key: "オーケストレーション", source: "text" },
    ]);
  });

  it("大きすぎる入力は断る", async () => {
    await expect(
      native.analyzeArticle({
        title: "",
        summary: "",
        html: "a".repeat(512 * 1024 + 1),
        categories: [],
        candidates: true,
        embedding: false,
      }),
    ).rejects.toThrow("exceeds 512 KiB");
  });

  it("モデルを読み込む前の埋め込みは失敗する", async () => {
    await expect(native.embedText("Rust")).rejects.toThrow("not loaded");
    await expect(
      native.analyzeArticle({
        title: "Rust",
        summary: "",
        html: "",
        categories: [],
        candidates: false,
        embedding: true,
      }),
    ).rejects.toThrow("not loaded");
  });

  it("壊れたモデルは読み込めず、記事の解析を作らない", async () => {
    const bytes = new TextEncoder().encode("{}");
    await expect(
      createArticleAnalyzer(native, { tokenizer: bytes, model: bytes, config: bytes }),
    ).rejects.toThrow("could not load the embedding model");
  });
});
