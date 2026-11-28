import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createArticleAnalyzer,
  loadNativeModule,
  readEmbeddingModelFiles,
} from "../../../src/platform/node/native";
import { NATIVE_MODULE } from "../../db";

/**
 * 本物の埋め込みのモデル（pnpm model:prepare で用意したもの）を、起動と同じ道（ファイルを読んで Rust に
 * 渡す）で読み込む。変換の道具と Rust の読み込みのどちらかが壊れたら、配備して起動が止まる前にここで
 * 分かる（docs/decisions/article-analysis.md の 6、container.md の 2）
 */
const MODEL_DIR =
  process.env.EMBEDDING_MODEL_DIR ||
  path.resolve(import.meta.dirname, "../../../models/potion-multilingual-128m");

describe("本物の埋め込みのモデル", () => {
  it("用意してある（なければ pnpm model:prepare を実行する）", () => {
    expect(existsSync(path.join(MODEL_DIR, "model.safetensors"))).toBe(true);
  });

  it("起動と同じ道で読み込み、記事と文を正規化した 256 次元のベクトルにする", async () => {
    const analyzer = await createArticleAnalyzer(
      loadNativeModule(NATIVE_MODULE),
      await readEmbeddingModelFiles(MODEL_DIR),
    );
    expect(analyzer.dimension).toBe(256);

    const result = await analyzer.analyze({
      title: "Claude Code で AI エージェントを動かす",
      summary: "",
      html: "<p>Anthropic のコーディングエージェント</p>",
      categories: [],
      candidates: true,
      embedding: true,
    });
    const article = result.embedding;
    expect(article).toBeInstanceOf(Float32Array);
    expect(article?.length).toBe(256);
    const norm = Math.hypot(...(article ?? []));
    expect(norm).toBeCloseTo(1, 4);
    expect(result.candidates?.map((c) => c.surface)).toContain("Claude Code");

    const near = await analyzer.embedText("AI エージェントでコードを書く");
    const far = await analyzer.embedText("ブラックフライデーのセール品");
    const cosine = (a: Float32Array | null | undefined, b: Float32Array | null) => {
      let sum = 0;
      for (let i = 0; i < 256; i++) sum += (a?.[i] ?? 0) * (b?.[i] ?? 0);
      return sum;
    };
    expect(cosine(article, near)).toBeGreaterThan(cosine(article, far));

    expect(
      await analyzer.analyze({
        title: "",
        summary: "",
        html: "<pre>only code</pre>",
        categories: [],
        candidates: false,
        embedding: true,
      }),
    ).toEqual({ embedding: null });
  });

  it("置き場がなければ、読めないことを例外で返す", async () => {
    await expect(readEmbeddingModelFiles(path.join(MODEL_DIR, "missing"))).rejects.toThrow(
      "could not read the embedding model",
    );
  });
});
