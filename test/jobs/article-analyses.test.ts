import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { insertArticles } from "../../src/db/articles";
import { insertFeed } from "../../src/db/feeds";
import { recordExtractedPageContent } from "../../src/db/page-contents";
import { readEvictionCandidates, readStorageUsage } from "../../src/db/storage";
import { runJob } from "../../src/jobs";
import { enqueueArticleAnalyses, hashSummary } from "../../src/jobs/article-analyses";
import { runCleanUp } from "../../src/jobs/clean-up";
import { jobSchema } from "../../src/jobs/job";
import type { Platform } from "../../src/platform";
import { testDb } from "../db";
import { createTestPlatform, fakeArticleAnalysis, statementHook } from "../helpers";

/*
 * 記事の解析の保存（docs/decisions/article-analysis.md の 3〜5、8、12）。仕事は本番と同じく runJob から
 * 動かす。記事は直接入れる（取り込みからの連鎖は article-analyses-chain.test.ts で確かめる）
 */

const DAY_MS = 24 * 60 * 60 * 1000;

async function seed(
  platform: Pick<Platform, "db">,
  articles: { id: string; feedId?: string; summary?: string | null; contentKey?: string | null }[],
) {
  for (const feedId of new Set(articles.map((a) => a.feedId ?? "feed"))) {
    await insertFeed(platform.db, {
      id: feedId,
      url: `https://example.com/${feedId}`,
      now: new Date(),
    });
  }
  await insertArticles(
    platform.db,
    articles.map((a) => ({
      id: a.id,
      feedId: a.feedId ?? "feed",
      guid: a.id,
      title: `タイトル ${a.id}`,
      summary: a.summary === undefined ? `要約 ${a.id}` : a.summary,
      url: null,
      author: null,
      publishedAt: new Date(),
      inCurrentFeed: false,
      contentKey: a.contentKey ?? null,
    })),
  );
}

const analyze = (platform: Platform, articleIds: string[]) =>
  runJob(platform, { type: "analyze-articles", articleIds });

const analysisOf = (id: string) =>
  testDb
    .prepare(
      `SELECT candidate_revision, candidate_status, candidate_generation, embedding_revision,
        embedding_status, length(embedding) AS embedding_bytes, summary_hash, feed_id
      FROM article_analyses WHERE article_id = ?`,
    )
    .bind(id)
    .first<Record<string, unknown>>();

const candidateRows = async (id: string) =>
  (
    await testDb
      .prepare("SELECT generation, key FROM article_candidates WHERE article_id = ? ORDER BY key")
      .bind(id)
      .all<{ generation: string; key: string }>()
  ).results;

/** 読む側と同じく、解析の行と世代が同じ候補の行だけ */
const readCandidates = async (id: string) =>
  (
    await testDb
      .prepare(
        `SELECT c.key FROM article_candidates c JOIN article_analyses a
          ON a.article_id = c.article_id AND a.candidate_generation = c.generation
        WHERE c.article_id = ? ORDER BY c.key`,
      )
      .bind(id)
      .all<{ key: string }>()
  ).results.map((row) => row.key);

const usedBytes = async () =>
  (await testDb.prepare("SELECT bytes FROM storage_usage WHERE id = 1").first<number>("bytes")) ??
  0;

beforeEach(async () => {
  await testDb.exec("DELETE FROM feeds");
  await testDb.exec("DELETE FROM content_notes");
  await testDb.exec("DELETE FROM content_sizes");
  await testDb.exec("UPDATE storage_usage SET limit_bytes = 268435456 WHERE id = 1");
});

describe("解析の行と候補の行", () => {
  it("候補と埋め込みを、版・状態・世代と一緒に保存する", async () => {
    const articleAnalysis = fakeArticleAnalysis();
    const { platform } = createTestPlatform({ articleAnalysis });
    await seed(platform, [{ id: "a" }]);
    await recordExtractedPageContent(platform.db, {
      articleId: "a",
      html: "<p>抜いた本文</p>",
      now: new Date(),
    });
    await analyze(platform, ["a"]);

    const row = await analysisOf("a");
    expect(row).toMatchObject({
      candidate_revision: 1,
      candidate_status: "done",
      embedding_revision: 1,
      embedding_status: "done",
      embedding_bytes: 1024,
      feed_id: "feed",
      summary_hash: await hashSummary("要約 a"),
    });
    expect(await candidateRows("a")).toEqual([
      { generation: row?.candidate_generation, key: "rust" },
    ]);
    expect(articleAnalysis.analyze).toHaveBeenCalledWith({
      title: "タイトル a",
      summary: "要約 a",
      html: "<p>抜いた本文</p>",
      categories: [],
      candidates: true,
      embedding: true,
    });
    // ベクトルは float32 のリトルエンディアン（1 つ目の次元が 1）
    const blob = await testDb
      .prepare("SELECT hex(substr(embedding, 1, 8)) AS head FROM article_analyses")
      .first<string>("head");
    expect(blob).toBe("0000803F00000000");
  });

  it("要約の文字の < をタグとして読ませない", async () => {
    const articleAnalysis = fakeArticleAnalysis();
    const { platform } = createTestPlatform({ articleAnalysis });
    await seed(platform, [{ id: "a", summary: "a <code> b & c" }]);
    await analyze(platform, ["a"]);
    expect(articleAnalysis.analyze.mock.calls[0]?.[0].summary).toBe("a &lt;code&gt; b &amp; c");
  });

  it("候補がなく、埋め込みの入力が空なら、どちらも「入力が空」にする", async () => {
    const articleAnalysis = fakeArticleAnalysis();
    articleAnalysis.analyze.mockResolvedValue({ candidates: [], embedding: null });
    const { platform } = createTestPlatform({ articleAnalysis });
    await seed(platform, [{ id: "a" }]);
    await analyze(platform, ["a"]);
    expect(await analysisOf("a")).toMatchObject({
      candidate_status: "empty",
      candidate_generation: null,
      embedding_status: "empty",
      embedding_bytes: null,
    });
    expect(await candidateRows("a")).toEqual([]);
  });

  it("候補の版だけが古いときは、候補だけを作り直し、埋め込みの列は変えない", async () => {
    const articleAnalysis = fakeArticleAnalysis();
    const { platform } = createTestPlatform({ articleAnalysis });
    await seed(platform, [{ id: "a" }]);
    await analyze(platform, ["a"]);
    const first = await analysisOf("a");

    articleAnalysis.candidateRevision = 2;
    articleAnalysis.analyze.mockResolvedValueOnce({
      candidates: [{ surface: "Go", key: "go", source: "text" }],
    });
    await analyze(platform, ["a"]);
    expect(articleAnalysis.analyze.mock.calls[1]?.[0]).toMatchObject({
      candidates: true,
      embedding: false,
    });
    const second = await analysisOf("a");
    expect(second).toMatchObject({
      candidate_revision: 2,
      embedding_revision: 1,
      embedding_status: "done",
      embedding_bytes: 1024,
    });
    expect(second?.candidate_generation).not.toBe(first?.candidate_generation);
    expect(await readCandidates("a")).toEqual(["go"]);
    // 入れ替わった古い世代の行は、片付けを待たずに消える
    expect(await candidateRows("a")).toEqual([
      { generation: second?.candidate_generation, key: "go" },
    ]);
  });
});

describe("重なりと途中の失敗", () => {
  it("2 つの解析が重なっても、読まれるのは印を書いたほうの世代の候補だけ", async () => {
    const articleAnalysis = fakeArticleAnalysis();
    const { platform: other } = createTestPlatform({ articleAnalysis });
    // 1 つ目の解析が候補の行を入れたあと、印を書く直前に、2 つ目の解析を最後まで動かす
    const hook = statementHook(/insert into article_analyses/, async () => {
      articleAnalysis.analyze.mockResolvedValueOnce({
        candidates: [{ surface: "Go", key: "go", source: "text" }],
        embedding: Float32Array.from({ length: 256 }, (_, i) => (i === 1 ? 1 : 0)),
      });
      await analyze(other, ["a"]);
    });
    const { platform } = createTestPlatform({ db: hook.db, articleAnalysis });
    await seed(platform, [{ id: "a" }]);
    await analyze(platform, ["a"]);

    expect(hook.fired()).toBe(true);
    expect(articleAnalysis.analyze).toHaveBeenCalledTimes(2);
    // 2 つの世代の候補の行が残るが、読まれるのは先に印を書いた 2 つ目の分だけ。同じ版は上書きしない
    expect(await candidateRows("a")).toHaveLength(2);
    expect(await readCandidates("a")).toEqual(["go"]);
    const blob = await testDb
      .prepare("SELECT hex(substr(embedding, 5, 4)) AS second FROM article_analyses")
      .first<string>("second");
    expect(blob).toBe("0000803F");
  });

  it("印を書く前に落ちても、ほかの記事は止まらず、やり直せば正しい状態になる", async () => {
    const articleAnalysis = fakeArticleAnalysis();
    const hook = statementHook(/insert into article_analyses/, async () => {
      throw new Error("crashed");
    });
    const { platform } = createTestPlatform({ db: hook.db, articleAnalysis });
    await seed(platform, [{ id: "a" }, { id: "b" }]);
    await analyze(platform, ["a", "b"]);

    expect(await analysisOf("a")).toBeNull();
    expect(await candidateRows("a")).toHaveLength(1);
    expect(await readCandidates("a")).toEqual([]);
    expect(await analysisOf("b")).toMatchObject({ candidate_status: "done" });

    await analyze(platform, ["a"]);
    expect(await analysisOf("a")).toMatchObject({ candidate_status: "done" });
    expect(await readCandidates("a")).toEqual(["rust"]);
  });

  it("候補を入れる前に記事が消えても、書き込みは壊れず、ほかの記事は解析する", async () => {
    const articleAnalysis = fakeArticleAnalysis();
    const hook = statementHook(/insert into article_candidates/, async () => {
      await testDb.exec("DELETE FROM articles WHERE id = 'a'");
    });
    const { platform } = createTestPlatform({ db: hook.db, articleAnalysis });
    await seed(platform, [{ id: "a" }, { id: "b" }]);
    const before = await usedBytes();
    await analyze(platform, ["a", "b"]);

    expect(hook.fired()).toBe(true);
    expect(await analysisOf("a")).toBeNull();
    expect(await candidateRows("a")).toEqual([]);
    expect(await analysisOf("b")).toMatchObject({ candidate_status: "done" });
    expect(await usedBytes()).toBeLessThan(before + 2000);
  });

  it("候補を入れたあと、印を書く前に記事が消えても、行は残らず、ほかの記事は解析する", async () => {
    const articleAnalysis = fakeArticleAnalysis();
    const hook = statementHook(/insert into article_analyses/, async () => {
      await testDb.exec("DELETE FROM articles WHERE id = 'a'");
    });
    const { platform } = createTestPlatform({ db: hook.db, articleAnalysis });
    await seed(platform, [{ id: "a" }, { id: "b" }]);
    await analyze(platform, ["a", "b"]);
    expect(hook.fired()).toBe(true);
    expect(await analysisOf("a")).toBeNull();
    expect(await candidateRows("a")).toEqual([]);
    expect(await analysisOf("b")).toMatchObject({ candidate_status: "done" });
  });

  it("決めた次元でない埋め込みは保存せず「失敗」と記録し、候補は保存する", async () => {
    const articleAnalysis = fakeArticleAnalysis();
    articleAnalysis.analyze.mockResolvedValueOnce({
      candidates: [{ surface: "Rust", key: "rust", source: "text" }],
      embedding: new Float32Array(255),
    });
    const { platform } = createTestPlatform({ articleAnalysis });
    await seed(platform, [{ id: "a" }]);
    await analyze(platform, ["a"]);
    expect(await analysisOf("a")).toMatchObject({
      candidate_status: "done",
      embedding_status: "failed",
      embedding_bytes: null,
    });
    expect(await readCandidates("a")).toEqual(["rust"]);
  });

  it("作り直した候補が空なら、入れ替わった古い世代の行も消える", async () => {
    const articleAnalysis = fakeArticleAnalysis();
    const { platform } = createTestPlatform({ articleAnalysis });
    await seed(platform, [{ id: "a" }]);
    await analyze(platform, ["a"]);
    articleAnalysis.candidateRevision = 2;
    articleAnalysis.analyze.mockResolvedValueOnce({ candidates: [] });
    await analyze(platform, ["a"]);
    expect(await analysisOf("a")).toMatchObject({
      candidate_revision: 2,
      candidate_status: "empty",
      candidate_generation: null,
    });
    expect(await candidateRows("a")).toEqual([]);
  });

  it("Rust が失敗した記事は「失敗」と記録し、同じ版では解析し直さない", async () => {
    const articleAnalysis = fakeArticleAnalysis();
    articleAnalysis.analyze.mockRejectedValueOnce(new Error("panicked"));
    const { platform } = createTestPlatform({ articleAnalysis });
    await seed(platform, [{ id: "a" }, { id: "b" }]);
    await analyze(platform, ["a", "b"]);

    expect(await analysisOf("a")).toMatchObject({
      candidate_status: "failed",
      candidate_generation: null,
      embedding_status: "failed",
      embedding_bytes: null,
    });
    expect(await analysisOf("b")).toMatchObject({ candidate_status: "done" });
    await analyze(platform, ["a"]);
    expect(articleAnalysis.analyze).toHaveBeenCalledTimes(2);
  });

  it("本文の置き場が読めない記事は、本文なしで解析する", async () => {
    const articleAnalysis = fakeArticleAnalysis();
    const { platform } = createTestPlatform({ articleAnalysis });
    platform.content = {
      ...platform.content,
      get: async () => {
        throw new Error("disk error");
      },
    };
    await seed(platform, [{ id: "a", contentKey: "feed/a" }]);
    await analyze(platform, ["a"]);
    expect(articleAnalysis.analyze.mock.calls[0]?.[0].html).toBe("");
    expect(await analysisOf("a")).toMatchObject({ candidate_status: "done" });
  });

  it("フィードの本文が置き場にあれば、それで解析する", async () => {
    const articleAnalysis = fakeArticleAnalysis();
    const { platform } = createTestPlatform({ articleAnalysis });
    await platform.content.put("feed/a", "<p>フィードの本文</p>");
    await seed(platform, [{ id: "a", contentKey: "feed/a" }]);
    await analyze(platform, ["a"]);
    expect(articleAnalysis.analyze.mock.calls[0]?.[0].html).toBe("<p>フィードの本文</p>");
  });
});

describe("同じ要約", () => {
  it("同じフィードにすでに同じ要約の解析があれば、要約を入力に使わない", async () => {
    const articleAnalysis = fakeArticleAnalysis();
    const { platform } = createTestPlatform({ articleAnalysis });
    const boilerplate = "Feedly の  あとで読む から移しました";
    await seed(platform, [
      { id: "a", summary: boilerplate },
      // NFKC と空白をそろえると同じ文
      { id: "b", summary: "Ｆｅｅｄｌｙ の あとで読む から移しました" },
      { id: "c", summary: boilerplate, feedId: "other" },
      { id: "d", summary: "" },
      { id: "e", summary: null },
      { id: "f", summary: " \u3000\n " },
    ]);
    await analyze(platform, ["a", "b", "c", "d", "e", "f"]);

    const summaries = articleAnalysis.analyze.mock.calls.map(([input]) => input.summary);
    // 最初の 1 件と、別のフィードの記事は使う
    expect(summaries).toEqual([boilerplate, "", boilerplate, "", "", ""]);
    expect((await analysisOf("a"))?.summary_hash).toBe((await analysisOf("b"))?.summary_hash);
    expect(await analysisOf("d")).toMatchObject({ summary_hash: null });
    expect(await analysisOf("e")).toMatchObject({ summary_hash: null });
    expect(await analysisOf("f")).toMatchObject({ summary_hash: null });
  });

  it("要約のハッシュは、状態によらず持つ（失敗した解析の行とも比べる）", async () => {
    const articleAnalysis = fakeArticleAnalysis();
    articleAnalysis.analyze.mockRejectedValueOnce(new Error("panicked"));
    const { platform } = createTestPlatform({ articleAnalysis });
    await seed(platform, [
      { id: "a", summary: "同じ要約" },
      { id: "b", summary: "同じ要約" },
    ]);
    await analyze(platform, ["a", "b"]);
    expect(await analysisOf("a")).toMatchObject({ candidate_status: "failed" });
    expect(articleAnalysis.analyze.mock.calls[1]?.[0].summary).toBe("");
  });
});

describe("容量", () => {
  it("解析・候補を保存容量に数え、記事が消えると連鎖で消えて戻る", async () => {
    const { platform } = createTestPlatform({ articleAnalysis: fakeArticleAnalysis() });
    const initial = await usedBytes();
    await seed(platform, [{ id: "a" }]);
    const before = await usedBytes();
    await analyze(platform, ["a"]);
    // 解析の行は 256 + ベクトル 1024、候補の行は 128 + 鍵 4 + 表記 4
    expect((await usedBytes()) - before).toBe(256 + 1024 + 128 + 4 + 4);

    await testDb.exec("DELETE FROM articles WHERE id = 'a'");
    expect(await analysisOf("a")).toBeNull();
    expect(await candidateRows("a")).toEqual([]);
    expect(await usedBytes()).toBe(initial);
  });

  it("容量による片付けの見積もりに、解析と候補の行を含める", async () => {
    const { platform } = createTestPlatform({ articleAnalysis: fakeArticleAnalysis() });
    const initial = await usedBytes();
    await seed(platform, [{ id: "a" }]);
    const articleBytes = (await usedBytes()) - initial;
    await seed(platform, [{ id: "b", feedId: "feed2" }]);
    await analyze(platform, ["a"]);
    const analysisBytes = 256 + 1024 + 128 + 4 + 4;
    expect(await readEvictionCandidates(platform.db, 10, articleBytes + analysisBytes)).toEqual([
      "a",
    ]);
    expect(await readEvictionCandidates(platform.db, 10, articleBytes + analysisBytes + 1)).toEqual(
      ["a", "b"],
    );
  });

  it("書いたあとの使用量が 90% ちょうどになるなら書かず、残りの記事も解析しない", async () => {
    const articleAnalysis = fakeArticleAnalysis();
    const { platform } = createTestPlatform({ articleAnalysis });
    await seed(platform, [{ id: "a" }, { id: "b" }]);
    const saved = await usedBytes();
    onTestFinished(() => testDb.exec(`UPDATE storage_usage SET bytes = ${saved} WHERE id = 1`));
    const total = 256 + 1024 + 128 + 4 + 4;
    // 上限 10,000 の 90% は 9,000。書いたあとがちょうど 9,000 になる使用量にする
    platform.retentionConfig = { maxBytes: 10_000 };
    await testDb.exec(`UPDATE storage_usage SET bytes = ${9_000 - total} WHERE id = 1`);
    await analyze(platform, ["a", "b"]);
    expect(articleAnalysis.analyze).toHaveBeenCalledTimes(1);
    expect(await analysisOf("a")).toBeNull();
    expect(await candidateRows("a")).toEqual([]);
    expect(await analysisOf("b")).toBeNull();
    expect(await usedBytes()).toBe(9_000 - total);

    // 1 バイト空けば書ける
    await testDb.exec(`UPDATE storage_usage SET bytes = ${9_000 - total - 1} WHERE id = 1`);
    await analyze(platform, ["a"]);
    expect(await analysisOf("a")).toMatchObject({ candidate_status: "done" });
    expect(await usedBytes()).toBe(9_000 - 1);
  });

  it("候補がなく埋め込みだけを書くときも、書いたあとが 90% ちょうどなら書かない", async () => {
    const articleAnalysis = fakeArticleAnalysis();
    articleAnalysis.analyze.mockImplementation(async () => ({
      candidates: [],
      embedding: Float32Array.from({ length: 256 }, (_, i) => (i === 0 ? 1 : 0)),
    }));
    const { platform } = createTestPlatform({ articleAnalysis });
    await seed(platform, [{ id: "a" }]);
    const saved = await usedBytes();
    onTestFinished(() => testDb.exec(`UPDATE storage_usage SET bytes = ${saved} WHERE id = 1`));
    platform.retentionConfig = { maxBytes: 10_000 };
    await testDb.exec(`UPDATE storage_usage SET bytes = ${9_000 - 1280} WHERE id = 1`);
    await analyze(platform, ["a"]);
    expect(articleAnalysis.analyze).toHaveBeenCalledTimes(1);
    expect(await analysisOf("a")).toBeNull();

    await testDb.exec(`UPDATE storage_usage SET bytes = ${9_000 - 1281} WHERE id = 1`);
    await analyze(platform, ["a"]);
    expect(await analysisOf("a")).toMatchObject({
      candidate_status: "empty",
      embedding_status: "done",
    });
  });

  it("まだ大きさを測っていない本文があるうちは、解析しない", async () => {
    const articleAnalysis = fakeArticleAnalysis();
    const { platform } = createTestPlatform({ articleAnalysis });
    await seed(platform, [{ id: "a" }]);
    await testDb.exec(
      "INSERT INTO content_sizes (key, bytes, article_bytes) VALUES ('feed/x', NULL, 0)",
    );
    await analyze(platform, ["a"]);
    expect(articleAnalysis.analyze).not.toHaveBeenCalled();
    await testDb.exec("DELETE FROM content_sizes");
    await analyze(platform, ["a"]);
    expect(await analysisOf("a")).toMatchObject({ candidate_status: "done" });
  });

  it("推論の前に使用量が上限の割合を超えていれば、計算しない", async () => {
    const articleAnalysis = fakeArticleAnalysis();
    const { platform } = createTestPlatform({ articleAnalysis });
    await seed(platform, [{ id: "a" }]);
    const usage = await readStorageUsage(platform.db);
    platform.retentionConfig = { maxBytes: Math.floor(usage.bytes / 0.9) };
    await analyze(platform, ["a"]);
    expect(articleAnalysis.analyze).not.toHaveBeenCalled();
    expect(await analysisOf("a")).toBeNull();
  });
});

describe("片付けと仕事の大きさ", () => {
  it("世代の合わない候補の行は、作ってから 1 日たったら消え、今の世代と作ったばかりの行は残る", async () => {
    const articleAnalysis = fakeArticleAnalysis();
    const hook = statementHook(/insert into article_analyses/, async () => {
      throw new Error("crashed");
    });
    const { platform: crashing } = createTestPlatform({ db: hook.db, articleAnalysis });
    await seed(crashing, [{ id: "a" }, { id: "b" }, { id: "c" }]);
    // a は印を書く前に落ちた解析の候補だけ、b は印を書いた解析の候補
    await analyze(crashing, ["a"]);
    const { platform } = createTestPlatform({ articleAnalysis });
    await analyze(platform, ["b"]);
    await testDb.exec(`UPDATE article_candidates SET created_at = created_at - ${DAY_MS + 1000}`);
    // c は実行中の解析の候補（作ったばかりで、まだ印がない）
    const hook2 = statementHook(/insert into article_analyses/, async () => {
      throw new Error("crashed");
    });
    await analyze(createTestPlatform({ db: hook2.db, articleAnalysis }).platform, ["c"]);

    const outcome = await runCleanUp(platform);
    expect(outcome.candidates).toBe(1);
    expect(await candidateRows("a")).toEqual([]);
    expect(await readCandidates("b")).toEqual(["rust"]);
    expect(await candidateRows("c")).toHaveLength(1);
  });

  it("1 つの仕事は 100 件までで、積むときに 100 件ずつに分ける", async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `a${i}`);
    expect(
      jobSchema.safeParse({ type: "analyze-articles", articleIds: ids.slice(0, 100) }).success,
    ).toBe(true);
    expect(
      jobSchema.safeParse({ type: "analyze-articles", articleIds: ids.slice(0, 101) }).success,
    ).toBe(false);
    const { platform, enqueued } = createTestPlatform();
    await enqueueArticleAnalyses(platform, ids);
    expect(enqueued).toEqual([
      { type: "analyze-articles", articleIds: ids.slice(0, 100) },
      { type: "analyze-articles", articleIds: ids.slice(100) },
    ]);
    await enqueueArticleAnalyses(platform, []);
    expect(enqueued).toHaveLength(2);
  });

  it("1 件の解析の例外で、ほかの記事は止まらない", async () => {
    const articleAnalysis = fakeArticleAnalysis();
    const hook = statementHook(/from articles a left join page_contents/, async () => {
      throw new Error("database is busy");
    });
    const { platform } = createTestPlatform({ db: hook.db, articleAnalysis });
    await seed(platform, [{ id: "a" }, { id: "b" }]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await analyze(platform, ["a", "b"]);
    warn.mockRestore();
    expect(await analysisOf("a")).toBeNull();
    expect(await analysisOf("b")).toMatchObject({ candidate_status: "done" });
  });
});
