import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { readArticleCategories } from "../../src/db/article-categories";
import { articles } from "../../src/db/schema";
import { readEvictionCandidates } from "../../src/db/storage";
import { runJob } from "../../src/jobs";
import { runFetchFeed } from "../../src/jobs/fetch-feed";
import type { Job } from "../../src/jobs/job";
import type { ArticleAnalyzer, Platform } from "../../src/platform";
import { loadNativeModule } from "../../src/platform/node/native";
import { NATIVE_MODULE, testDb } from "../db";
import {
  createTestPlatform,
  createUser,
  fakeFetch,
  statementHook,
  subscribeFeed,
} from "../helpers";

/*
 * フィードのカテゴリ（docs/decisions/article-analysis.md の 8、10、12）。取得の仕事で保存し、解析の候補の
 * 出どころに使う。本番と同じく、取得の仕事と解析の仕事から呼ぶ
 */

const native = loadNativeModule(NATIVE_MODULE);

/** 本物の Rust で候補だけを作る（埋め込みのモデルは読み込まない。埋め込みは「入力が空」になる） */
const candidatesOnly: ArticleAnalyzer = {
  ...native.analysisInfo(),
  async analyze(input) {
    const result = await native.analyzeArticle({
      ...input,
      categories: [...input.categories],
      embedding: false,
    });
    return { candidates: result.candidates ?? [], embedding: null };
  },
  async embedText() {
    return null;
  },
};

const rss = (items: { link: string | null; title: string; categories: string[] }[]) =>
  `<rss version="2.0"><channel><title>Blog</title><link>https://blog.example/</link>
    ${items
      .map(
        (item, i) =>
          `<item><title>${item.title}</title>${item.link === null ? "" : `<link>${item.link}</link>`}<guid isPermaLink="false">g${i}</guid>
          ${item.categories.map((name) => `<category>${name}</category>`).join("")}</item>`,
      )
      .join("")}
  </channel></rss>`;

async function setUp(
  items: { link: string | null; title: string; categories: string[] }[],
  overrides: Partial<Platform> = {},
) {
  const user = await createUser();
  const fetched = fakeFetch(() => new Response(rss(items)));
  const created = createTestPlatform({
    fetch: fetched.fetch,
    articleAnalysis: candidatesOnly,
    ...overrides,
  });
  const feed = await subscribeFeed(created.platform, { userId: user.id });
  const ids = async () => {
    const rows = await created.platform.db
      .select({ id: articles.id, guid: articles.guid })
      .from(articles)
      .where(eq(articles.feedId, feed.id))
      .all();
    return items.map((_, i) => rows.find((row) => row.guid === `g${i}`)?.id ?? "");
  };
  return { ...created, feed, ids };
}

const candidatesOf = async (id: string) =>
  (
    await testDb
      .prepare(
        `SELECT c.surface, c.key, c.source FROM article_candidates c JOIN article_analyses a
          ON a.article_id = c.article_id AND a.candidate_generation = c.generation
        WHERE c.article_id = ?`,
      )
      .bind(id)
      .all()
  ).results;

const usedBytes = async () =>
  (await testDb.prepare("SELECT bytes FROM storage_usage WHERE id = 1").first<number>("bytes")) ??
  0;

beforeEach(async () => {
  await testDb.exec("DELETE FROM feeds");
  await testDb.exec("UPDATE storage_usage SET limit_bytes = 268435456 WHERE id = 1");
});

describe("取得の仕事", () => {
  it("記事ごとに、整えたカテゴリを 10 個まで、ページを抜く仕事と解析の仕事を積む前に保存する", async () => {
    const categories = [
      "技術",
      "2024",
      " Rust ",
      ...Array.from({ length: 10 }, (_, i) => `Tag${i}`),
    ];
    const link = "https://blog.example/posts/1";
    const user = await createUser();
    const fetched = fakeFetch(
      () =>
        new Response(
          rss([
            { link, title: "記事", categories },
            { link: null, title: "URL のない記事", categories: ["Go"] },
          ]),
        ),
    );
    const { platform, enqueued } = createTestPlatform({ fetch: fetched.fetch });
    // 仕事を積んだ時点で、カテゴリがもう入っているかを記録する
    const seen: { type: string; categories: number }[] = [];
    const enqueue = platform.jobs.enqueue;
    platform.jobs.enqueue = async (jobs) => {
      const count = await testDb
        .prepare("SELECT count(*) AS n FROM article_categories")
        .first<number>("n");
      for (const job of jobs) seen.push({ type: job.type, categories: count ?? 0 });
      await enqueue(jobs);
    };
    const feed = await subscribeFeed(platform, { userId: user.id });
    await runFetchFeed(platform, feed.id);

    const rows = await platform.db
      .select({ id: articles.id, guid: articles.guid })
      .from(articles)
      .where(eq(articles.feedId, feed.id))
      .all();
    const first = rows.find((row) => row.guid === "g0")?.id ?? "";
    const second = rows.find((row) => row.guid === "g1")?.id ?? "";
    expect(await readArticleCategories(platform.db, first)).toEqual([
      "技術",
      "Rust",
      ...Array.from({ length: 8 }, (_, i) => `Tag${i}`),
    ]);
    expect(await readArticleCategories(platform.db, second)).toEqual(["Go"]);
    const jobs = seen.filter(
      (job) => job.type === "extract-page" || job.type === "analyze-articles",
    );
    expect(jobs.map((job) => job.type).sort()).toEqual(["analyze-articles", "extract-page"]);
    expect(jobs.every((job) => job.categories === 11)).toBe(true);
    expect(enqueued.filter((job: Job) => job.type === "analyze-articles")).toEqual([
      { type: "analyze-articles", articleIds: [second] },
    ]);
  });

  it("記事を入れたあと、カテゴリを入れる前に落ちたら、その記事のカテゴリは欠ける", async () => {
    const hook = statementHook(/insert into article_categories/, async () => {
      throw new Error("crashed");
    });
    const t = await setUp([{ link: null, title: "記事", categories: ["Rust"] }], { db: hook.db });
    // 取得の仕事は例外を投げ、仕事の表がやり直す
    await expect(runFetchFeed(t.platform, t.feed.id)).rejects.toThrow();
    // やり直しでは記事を入れ直さないので、カテゴリは入らない（受け入れる）
    await runFetchFeed(t.platform, t.feed.id);
    const [id = ""] = await t.ids();
    expect(id).not.toBe("");
    expect(await readArticleCategories(t.platform.db, id)).toEqual([]);
  });
});

describe("解析の候補", () => {
  it("カテゴリは出どころ「カテゴリ」の候補になり、記事の文字と同じ鍵ならカテゴリを優先する", async () => {
    const t = await setUp([
      { link: null, title: "KUBERNETES と Docker の話", categories: ["Kubernetes", "生成AI"] },
    ]);
    await runFetchFeed(t.platform, t.feed.id);
    const [id = ""] = await t.ids();
    await runJob(t.platform, { type: "analyze-articles", articleIds: [id] });

    expect(await candidatesOf(id)).toEqual(
      expect.arrayContaining([
        { surface: "Kubernetes", key: "kubernetes", source: "category" },
        { surface: "生成AI", key: "生成ai", source: "category" },
        { surface: "Docker", key: "docker", source: "text" },
      ]),
    );
    expect(await candidatesOf(id)).toHaveLength(3);
  });
});

describe("容量", () => {
  it("カテゴリを保存容量と片付けの見積もりに数え、記事が消えると連鎖で消えて戻る", async () => {
    const user = await createUser();
    let body = rss([{ link: null, title: "記事", categories: ["Rust", "生成AI"] }]);
    const fetched = fakeFetch(() => new Response(body));
    const { platform } = createTestPlatform({ fetch: fetched.fetch });
    const feed = await subscribeFeed(platform, { userId: user.id });
    await runFetchFeed(platform, feed.id);
    const tagged = await usedBytes();
    const [first] = await platform.db
      .select({ id: articles.id })
      .from(articles)
      .where(eq(articles.feedId, feed.id))
      .all();
    const id = first?.id ?? "";
    // カテゴリを除くと、記事の分だけ減る。Rust は 4 バイト、生成AI は 8 バイト、どちらも 1 行 128 バイト
    await testDb.exec(`DELETE FROM article_categories WHERE article_id = '${id}'`);
    expect(tagged - (await usedBytes())).toBe(128 + 4 + 128 + 8);
    await testDb.exec(
      `INSERT INTO article_categories (article_id, position, name) VALUES ('${id}', 0, 'Rust'), ('${id}', 1, '生成AI')`,
    );
    expect(await usedBytes()).toBe(tagged);

    // あとから入った記事より先に片付ける見積もりに、カテゴリの分も入る
    body = rss([
      { link: null, title: "記事", categories: ["Rust", "生成AI"] },
      { link: null, title: "記事", categories: [] },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await runFetchFeed(platform, feed.id);
    // フィードに載っている記事は片付けないので、外れたことにする
    await testDb.exec(`UPDATE articles SET in_current_feed = 0 WHERE feed_id = '${feed.id}'`);
    // 先に入った記事だけで足りる回収量の上限（見積もりの境目）を探す
    const boundary = async () => {
      let low = 1;
      let high = 1_000_000;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        const chosen = await readEvictionCandidates(platform.db, 10, mid);
        if (chosen.length === 1) low = mid;
        else high = mid - 1;
      }
      expect(await readEvictionCandidates(platform.db, 10, low)).toEqual([id]);
      return low;
    };
    const withCategories = await boundary();
    await testDb.exec(`DELETE FROM article_categories WHERE article_id = '${id}'`);
    expect(withCategories - (await boundary())).toBe(128 + 4 + 128 + 8);

    await testDb.exec(`DELETE FROM articles WHERE feed_id = '${feed.id}'`);
    expect(await readArticleCategories(platform.db, id)).toEqual([]);
    expect(
      await testDb.prepare("SELECT count(*) AS n FROM article_categories").first<number>("n"),
    ).toBe(0);
  });
});
