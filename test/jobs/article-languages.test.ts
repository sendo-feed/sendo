import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getArticleLanguage, recordArticleLanguage } from "../../src/db/article-languages";
import { insertArticles } from "../../src/db/articles";
import { insertFeed } from "../../src/db/feeds";
import { recordExtractedPageContent } from "../../src/db/page-contents";
import * as schema from "../../src/db/schema";
import { configureStorage, readEvictionCandidates, readStorageUsage } from "../../src/db/storage";
import { runJob } from "../../src/jobs";
import { LANGUAGE_BATCH_SIZE } from "../../src/jobs/article-languages";
import { enqueueLanguageDetection, runScheduled } from "../../src/jobs/schedule";
import type { LanguageDetectionResult } from "../../src/platform";
import { createTestPlatform, d1BeforeStatement } from "../helpers";

const result = {
  language: "ja",
  status: "detected" as const,
  score: 1,
  margin: 1,
  inputHash: "a".repeat(64),
};
const detector = () => ({
  detector: "test",
  pipelineRevision: 1,
  detect: vi.fn(async (_html: string): Promise<LanguageDetectionResult> => result),
});
const job = { type: "detect-article-languages" as const };
type Platform = ReturnType<typeof createTestPlatform>["platform"];

async function seed(platform: Platform, ids: string[], content = false) {
  await insertFeed(platform.db, { id: "feed", url: "https://example.com/feed", now: new Date() });
  await insertArticles(
    platform.db,
    ids.map((id) => ({
      id,
      feedId: "feed",
      guid: id,
      title: "タイトル<code>文字も説明の一部です</code>",
      summary: "本文のない記事の要約です。",
      url: null,
      author: null,
      publishedAt: new Date(),
      inCurrentFeed: false,
      contentKey: content ? `feed/${id}` : null,
    })),
  );
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM feeds");
  await env.DB.exec("DELETE FROM content_notes");
  await env.DB.exec("DELETE FROM content_sizes");
  await env.DB.exec("UPDATE storage_usage SET limit_bytes = 268435456 WHERE id = 1");
});

describe("主言語の背景判定と保存", () => {
  it("metadataは暫定とし、あとで抜けたページの結果を別に保存する", async () => {
    const languageDetection = detector();
    const { platform } = createTestPlatform({ languageDetection });
    await seed(platform, ["article"]);
    await runJob(platform, job);
    expect(await getArticleLanguage(platform.db, "article", "metadata")).toMatchObject({
      status: "provisional",
      language: "ja",
    });
    expect(languageDetection.detect.mock.calls[0]?.[0]).toContain("&lt;code&gt;");
    await recordExtractedPageContent(platform.db, {
      articleId: "article",
      html: "<p>ページの本文</p>",
      now: new Date(),
    });
    await runJob(platform, job);
    expect(await getArticleLanguage(platform.db, "article", "page")).toMatchObject({
      status: "detected",
      language: "ja",
    });
    expect(languageDetection.detect).toHaveBeenCalledTimes(2);
    await runJob(platform, job);
    expect(languageDetection.detect).toHaveBeenCalledTimes(2);
  });

  it("フィード本文を使い、不十分な結果も保存して繰り返し判定しない", async () => {
    const languageDetection = detector();
    languageDetection.detect.mockResolvedValue({
      ...result,
      language: "und",
      status: "insufficient",
    });
    const { platform } = createTestPlatform({ languageDetection });
    await seed(platform, ["body"], true);
    await platform.content.put("feed/body", "<pre>code only</pre>");
    await runJob(platform, job);
    expect(languageDetection.detect).toHaveBeenCalledWith("<pre>code only</pre>");
    expect(await getArticleLanguage(platform.db, "body", "feed")).toMatchObject({
      language: "und",
      status: "insufficient",
    });
    expect(await getArticleLanguage(platform.db, "body", "metadata")).toBeUndefined();
    await runJob(platform, job);
    expect(languageDetection.detect).toHaveBeenCalledTimes(1);
  });

  it("1仕事10件で引き継ぎ、途中で未処理が残っても次回拾い直す", async () => {
    const languageDetection = detector();
    const { platform, enqueued, resetQueryCount, queryCount } = createTestPlatform({
      languageDetection,
    });
    await seed(
      platform,
      Array.from({ length: LANGUAGE_BATCH_SIZE + 1 }, (_, n) => `a${String(n).padStart(2, "0")}`),
    );
    languageDetection.detect.mockRejectedValueOnce(new Error("native failure"));
    resetQueryCount();
    await runJob(platform, job);
    expect(queryCount()).toBeLessThanOrEqual(42);
    expect(languageDetection.detect).toHaveBeenCalledTimes(10);
    expect(enqueued).toHaveLength(1);
    const next = enqueued[0];
    if (!next) throw new Error("missing continuation");
    await runJob(platform, next);
    expect(await getArticleLanguage(platform.db, "a10", "metadata")).toBeDefined();
    await runJob(platform, job);
    expect(await getArticleLanguage(platform.db, "a00", "metadata")).toBeDefined();
    expect(languageDetection.detect).toHaveBeenCalledTimes(12);
  });

  it("先頭の本文が読めなくても後ろの記事を処理し、本文が戻れば再判定する", async () => {
    const languageDetection = detector();
    const { platform, enqueued } = createTestPlatform({ languageDetection });
    const ids = Array.from({ length: 11 }, (_, n) => `body${String(n).padStart(2, "0")}`);
    await seed(platform, ids, true);
    const get = vi.spyOn(platform.content, "get").mockResolvedValue(null);
    get.mockImplementation(async (key) => (key === "feed/body10" ? "<p>最後の本文</p>" : null));
    await runJob(platform, job);
    const next = enqueued[0];
    if (!next) throw new Error("missing continuation");
    await runJob(platform, next);
    expect(languageDetection.detect).toHaveBeenCalledTimes(1);
    expect(await getArticleLanguage(platform.db, "body00", "feed")).toBeUndefined();
    get.mockResolvedValue("<p>復旧した本文</p>");
    await runJob(platform, job);
    expect(await getArticleLanguage(platform.db, "body00", "feed")).toBeDefined();
  });

  it("同じ版は更新せず、新しい版のあとに古い保存が来ても戻さない", async () => {
    const { platform } = createTestPlatform();
    await seed(platform, ["article"]);
    const input = {
      ...result,
      articleId: "article",
      source: "metadata" as const,
      detector: "test",
      pipelineRevision: 1,
    };
    expect(await recordArticleLanguage(platform.db, input)).toBe(true);
    expect(await recordArticleLanguage(platform.db, input)).toBe(false);
    expect(
      await recordArticleLanguage(platform.db, { ...input, pipelineRevision: 2, language: "en" }),
    ).toBe(true);
    expect(await recordArticleLanguage(platform.db, input)).toBe(false);
    expect(await getArticleLanguage(platform.db, "article", "metadata")).toMatchObject({
      pipelineRevision: 2,
      language: "en",
    });
  });

  it("保存直前に記事が消えても復活させず、派生行を連鎖して消す", async () => {
    const { platform } = createTestPlatform();
    await seed(platform, ["gone"]);
    const input = {
      ...result,
      articleId: "gone",
      source: "metadata" as const,
      detector: "test",
      pipelineRevision: 1,
    };
    await recordArticleLanguage(platform.db, input);
    const race = d1BeforeStatement(/insert into article_languages/, async () => {
      await env.DB.exec("DELETE FROM articles WHERE id = 'gone'");
    });
    expect(
      await recordArticleLanguage(drizzle(race.db, { schema }), { ...input, pipelineRevision: 2 }),
    ).toBe(false);
    expect(race.fired()).toBe(true);
    expect(await getArticleLanguage(platform.db, "gone", "metadata")).toBeUndefined();
  });

  it("容量に含め、満杯では新規保存と連続投入を止め、同じ行の版更新は許す", async () => {
    const languageDetection = detector();
    const { platform, enqueued } = createTestPlatform({ languageDetection });
    await seed(platform, ["a", "b"]);
    const before = await readStorageUsage(platform.db);
    platform.retentionConfig = { maxBytes: before.bytes + 512 };
    await runJob(platform, job);
    expect((await readStorageUsage(platform.db)).bytes).toBe(before.bytes + 512);
    expect(await getArticleLanguage(platform.db, "a", "metadata")).toBeDefined();
    expect(await getArticleLanguage(platform.db, "b", "metadata")).toBeUndefined();
    expect(enqueued).toEqual([]);
    const row = await getArticleLanguage(platform.db, "a", "metadata");
    if (!row) throw new Error("missing stored result");
    expect(await recordArticleLanguage(platform.db, { ...row, pipelineRevision: 2 })).toBe(true);
    expect((await readStorageUsage(platform.db)).bytes).toBe(before.bytes + 512);
    await configureStorage(platform.db, before.bytes + 1024);
    expect(await recordArticleLanguage(platform.db, { ...row, articleId: "b" })).toBe(true);
  });

  it("削除の回収量に言語行を含め、記事と一緒に容量を返す", async () => {
    const { platform } = createTestPlatform();
    const initial = (await readStorageUsage(platform.db)).bytes;
    await seed(platform, ["a"]);
    const articleBytes = (await readStorageUsage(platform.db)).bytes - initial;
    await seed(platform, ["b"]);
    await recordArticleLanguage(platform.db, {
      ...result,
      articleId: "a",
      source: "metadata",
      detector: "test",
      pipelineRevision: 1,
    });
    expect(await readEvictionCandidates(platform.db, 10, articleBytes + 512)).toEqual(["a"]);
    await env.DB.exec("DELETE FROM articles WHERE id = 'a'");
    expect((await readStorageUsage(platform.db)).bytes).toBe(initial + articleBytes);
  });

  it("判定器のない版は定期実行でも判定の仕事を積まず、既存の仕事も捨てる", async () => {
    const t = createTestPlatform();
    t.resetQueryCount();
    await runJob(t.platform, job);
    expect(t.queryCount()).toBe(0);
    await runScheduled(t.platform, new Date("2026-11-17T00:00:00Z"));
    expect(t.enqueued).not.toContainEqual(job);
    const enabled = createTestPlatform({ languageDetection: detector() });
    await runScheduled(enabled.platform, new Date("2026-11-17T00:00:00Z"));
    expect(enabled.enqueued).toContainEqual(job);
  });

  it("言語判定の投入が失敗しても呼び出し元を落とさず、次回また投入する", async () => {
    const { platform, enqueued } = createTestPlatform({ languageDetection: detector() });
    const enqueue = vi.spyOn(platform.jobs, "enqueue");
    enqueue.mockRejectedValueOnce(new Error("queue temporarily unavailable"));
    await expect(enqueueLanguageDetection(platform)).resolves.toBeUndefined();
    await enqueueLanguageDetection(platform);
    expect(enqueued).toEqual([job]);
  });
});
