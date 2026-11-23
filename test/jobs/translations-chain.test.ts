import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { articles, articleTranslations } from "../../src/db/schema";
import { runJob } from "../../src/jobs";
import { type Job, jobSchema } from "../../src/jobs/job";
import type { LanguageDetectionResult, PageContentExtractor, Platform } from "../../src/platform";
import { createClaudeTranslator } from "../../src/translation/claude";
import { testDb } from "../db";
import {
  createTestPlatform,
  createUser,
  fakeFetch,
  recordingSyncUpdates,
  requestApp,
  subscribeFeed,
} from "../helpers";

/*
 * 判定を保存したとき、ページを抜けなかったと記録したときに、その記事について訳すかどうかを決める
 * 仕事を積む（docs/decisions/jobs.md の 13、translation.md の 1）。本番と同じく、取得の仕事、抜く
 * 仕事、判定の仕事、決める仕事の順に動かす
 */

const EN =
  "Codemods are automated scripts that transform code to apply API changes across a codebase.";
const JA =
  "テストを先に書いてから、小さな変更を重ねる進め方を、社内の勉強会で紹介しました。".repeat(3);

/** 文字で主言語を決める偽の判定。英語の印も日本語もなければ判定できない */
const languageDetection = {
  detector: "test",
  pipelineRevision: 1,
  detect: vi.fn(async (html: string): Promise<LanguageDetectionResult> => {
    const base = { score: 1, margin: 1, inputHash: "a".repeat(64) };
    if (/Codemods/.test(html)) return { ...base, language: "en", status: "detected" };
    if (/[ぁ-ん]/.test(html)) return { ...base, language: "ja", status: "detected" };
    return { ...base, language: "und", status: "insufficient" };
  }),
};

const rss = (items: { link: string; body: string }[]) =>
  `<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>Blog</title><link>https://blog.example/</link>
    ${items.map((item, i) => `<item><title>Post ${i}</title><link>${item.link}</link><guid>${i}</guid><description>Post ${i}</description><content:encoded><![CDATA[<p>${item.body}</p>]]></content:encoded></item>`).join("")}
  </channel></rss>`;

/**
 * count 件の記事を持つフィードを購読して取得する。page は抜いたページの本文（null なら抜けない）。
 * 取得の仕事が積んだ仕事は enqueued に残る
 */
async function setUp(
  options: {
    count?: number;
    feedBody?: string;
    page?: string | null;
    translator?: boolean;
    enqueue?: Platform["jobs"]["enqueue"];
  } = {},
) {
  const user = await createUser();
  const links = Array.from(
    { length: options.count ?? 1 },
    (_, i) => `https://${crypto.randomUUID()}.example.com/posts/${i}`,
  );
  const fetched = fakeFetch((url) =>
    // Claude API は使わない（定期実行の手入れがバッチを送ろうとしても、作れずに印を残すだけ）
    url.hostname === "api.anthropic.com"
      ? new Response(null, { status: 503 })
      : url.pathname === "/robots.txt"
        ? new Response(null, { status: 404 })
        : links.includes(url.href)
          ? new Response("<html><body><p>page</p></body></html>", {
              headers: { "content-type": "text/html; charset=utf-8" },
            })
          : new Response(rss(links.map((link) => ({ link, body: options.feedBody ?? EN })))),
  );
  // 抜いた本文は 100 文字に満たないと、抜けなかったものとして記録する（content.md の 14）
  const page = options.page === undefined ? `${EN} ${EN}` : options.page;
  const pageContent: PageContentExtractor = {
    async extract() {
      return page === null ? null : { title: "Post", html: `<p>${page}</p>`, textLength: 999 };
    },
  };
  const recording = recordingSyncUpdates();
  const created = createTestPlatform({
    fetch: fetched.fetch,
    languageDetection,
    pageContent,
    syncUpdates: recording.syncUpdates,
    ...(options.enqueue !== undefined && { jobs: { enqueue: options.enqueue } }),
  });
  const platform: Platform = {
    ...created.platform,
    ...(options.translator !== false && {
      translator: createClaudeTranslator({
        apiKey: "sk-test-secret",
        fetch: fetched.fetch,
        now: () => new Date(),
      }),
    }),
  };
  const feed = await subscribeFeed(platform, { userId: user.id });
  await runJob(platform, { type: "fetch-feed", feedId: feed.id });
  const ids = (
    await platform.db
      .select({ id: articles.id })
      .from(articles)
      .where(eq(articles.feedId, feed.id))
      .orderBy(articles.id)
      .all()
  ).map((row) => row.id);
  const enqueued = created.enqueued;
  /** 積まれた仕事のうち、type のものを順に（続きも含めて）動かす */
  async function run(type: Job["type"]) {
    for (let job = enqueued.find((j) => j.type === type); job; ) {
      enqueued.splice(enqueued.indexOf(job), 1);
      await runJob(platform, job);
      job = enqueued.find((j) => j.type === type);
    }
  }
  return { platform, user, ids, enqueued, run, notified: recording.notified };
}

const decideJobs = (enqueued: Job[]) => enqueued.filter((j) => j.type === "decide-translations");

const translationOf = (platform: Platform, id: string) =>
  platform.db.select().from(articleTranslations).where(eq(articleTranslations.articleId, id)).get();

beforeEach(async () => {
  await testDb.exec("DELETE FROM feeds");
  await testDb.exec("UPDATE storage_usage SET limit_bytes = 268435456 WHERE id = 1");
  languageDetection.detect.mockClear();
});

describe("判定を保存したときに決める", () => {
  it("英語のページを抜いて判定すると、決める仕事が積まれ、定期実行を待たずに queued になって届く", async () => {
    const t = await setUp();
    const [id] = t.ids;
    if (!id) throw new Error("no article");
    await t.run("extract-page");
    await t.run("detect-article-languages");
    expect(decideJobs(t.enqueued)).toEqual([{ type: "decide-translations", articleIds: [id] }]);

    await t.run("decide-translations");
    expect(await translationOf(t.platform, id)).toMatchObject({
      status: "queued",
      language: "en",
    });
    expect(t.notified).toContain(t.user.id);
    const res = await requestApp(t.platform, "/api/v1/sync", { token: t.user.token });
    const body = (await res.json()) as {
      articles: { id: string; translation: { language: string; status: string } | null }[];
    };
    expect(body.articles.find((a) => a.id === id)?.translation).toMatchObject({
      language: "en",
      status: "queued",
    });
  });

  it("日本語のページの記事は skipped になり、差分同期では翻訳の項目が届かない", async () => {
    const t = await setUp({ feedBody: JA, page: JA });
    const [id] = t.ids;
    if (!id) throw new Error("no article");
    await t.run("extract-page");
    await t.run("detect-article-languages");
    await t.run("decide-translations");
    expect(await translationOf(t.platform, id)).toMatchObject({ status: "skipped" });
    const res = await requestApp(t.platform, "/api/v1/sync", { token: t.user.token });
    const body = (await res.json()) as { articles: { id: string; translation: unknown }[] };
    expect(body.articles.find((a) => a.id === id)?.translation).toBeNull();
  });

  it("フィードの判定だけが済み、ページをまだ抜いていない記事は、決める仕事を動かしても行を作らない", async () => {
    const t = await setUp();
    const [id] = t.ids;
    if (!id) throw new Error("no article");
    await t.run("detect-article-languages");
    expect(decideJobs(t.enqueued)).toHaveLength(1);
    await t.run("decide-translations");
    expect(await translationOf(t.platform, id)).toBeUndefined();
  });

  it("ページの判定だけが済み（und）、フィードの判定がまだの記事は決めず、フィードの判定が英語で入ると queued になる", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // 文字を含まない、判定できないページの本文（抜けたものとして残る長さ）
    const t = await setUp({ page: "12345 67890 ".repeat(20) });
    const [id] = t.ids;
    if (!id) throw new Error("no article");
    await t.run("extract-page");
    // フィードの本文が一時的に読めず、ページの判定だけが入る
    const get = vi.spyOn(t.platform.content, "get").mockRejectedValue(new Error("EIO"));
    await t.run("detect-article-languages");
    get.mockRestore();
    expect(
      await testDb
        .prepare("SELECT source, language FROM article_languages WHERE article_id = ?")
        .bind(id)
        .all(),
    ).toEqual({
      results: [{ source: "page", language: "und" }],
    });
    await t.run("decide-translations");
    expect(await translationOf(t.platform, id)).toBeUndefined();

    // 定期実行がフィードの判定を拾うと、決める仕事が積まれる
    await runJob(t.platform, { type: "detect-article-languages" });
    await t.run("decide-translations");
    expect(await translationOf(t.platform, id)).toMatchObject({ status: "queued", language: "en" });
  });
});

describe("ページを抜けなかったと記録したときに決める", () => {
  it("フィードの判定が英語なら、抜けなかったと書いたあとに決める仕事が積まれ、queued になる", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = await setUp({ page: null });
    const [id] = t.ids;
    if (!id) throw new Error("no article");
    await t.run("detect-article-languages");
    await t.run("decide-translations");
    expect(await translationOf(t.platform, id)).toBeUndefined();

    await t.run("extract-page");
    expect(decideJobs(t.enqueued)).toEqual([{ type: "decide-translations", articleIds: [id] }]);
    await t.run("decide-translations");
    expect(await translationOf(t.platform, id)).toMatchObject({ status: "queued", language: "en" });
  });
});

describe("積む記事と条件", () => {
  it("判定の仕事 1 つが保存した記事について、決める仕事を 1 つだけ積む。行のある記事と 1 日を過ぎた記事は含めず、残らなければ積まない", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = await setUp({ count: 3, page: null });
    const [a, b, old] = t.ids;
    if (!a || !b || !old) throw new Error("no articles");
    await t.run("extract-page");
    t.enqueued.splice(
      0,
      t.enqueued.length,
      ...t.enqueued.filter((j) => j.type !== "decide-translations"),
    );
    // 取り込んでから 1 日を過ぎた記事（作るのに手間がかかるので、直接書く）
    await testDb.exec(
      `UPDATE articles SET created_at = created_at - ${2 * 24 * 60 * 60 * 1000} WHERE id = '${old}'`,
    );
    await t.run("detect-article-languages");
    expect(decideJobs(t.enqueued)).toEqual([{ type: "decide-translations", articleIds: [a, b] }]);
    await t.run("decide-translations");
    expect(await translationOf(t.platform, a)).toMatchObject({ status: "queued" });
    expect(await translationOf(t.platform, old)).toBeUndefined();

    // 版を上げて判定し直しても、行のある記事と 1 日を過ぎた記事しかないので積まない
    const revised = {
      ...t.platform,
      languageDetection: { ...languageDetection, pipelineRevision: 2 },
    };
    await runJob(revised, { type: "detect-article-languages" });
    expect(decideJobs(t.enqueued)).toEqual([]);
  });

  it("判定の仕事 1 つがちょうど 10 件を保存したら、決める仕事を 1 つ積み、仕事の形（10 件まで）に収まる", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = await setUp({ count: 10, page: null });
    await t.run("extract-page");
    t.enqueued.splice(
      0,
      t.enqueued.length,
      ...t.enqueued.filter((j) => j.type !== "decide-translations"),
    );
    await t.run("detect-article-languages");
    const jobs = decideJobs(t.enqueued);
    expect(jobs).toHaveLength(1);
    expect(jobSchema.parse(jobs[0])).toEqual({ type: "decide-translations", articleIds: t.ids });
    await t.run("decide-translations");
    for (const id of t.ids) {
      expect(await translationOf(t.platform, id)).toMatchObject({ status: "queued" });
    }
  });

  it("API キーのない sendo では、決める仕事を積まない", async () => {
    const t = await setUp({ translator: false });
    await t.run("extract-page");
    await t.run("detect-article-languages");
    expect(decideJobs(t.enqueued)).toEqual([]);
  });

  it("誰の受信箱にもない記事は、決める仕事を動かしても行を作らない", async () => {
    const t = await setUp();
    const [id] = t.ids;
    if (!id) throw new Error("no article");
    await t.run("extract-page");
    await t.run("detect-article-languages");
    await testDb.exec(`DELETE FROM user_articles WHERE article_id = '${id}'`);
    await t.run("decide-translations");
    expect(await translationOf(t.platform, id)).toBeUndefined();
  });

  it("決める仕事と定期実行の手入れが重なっても、行は 1 つで、状態は変わらない", async () => {
    const t = await setUp();
    const [id] = t.ids;
    if (!id) throw new Error("no article");
    await t.run("extract-page");
    await t.run("detect-article-languages");
    const [job] = decideJobs(t.enqueued);
    if (!job) throw new Error("no decide job");
    await runJob(t.platform, { type: "maintain-translations" });
    const before = await translationOf(t.platform, id);
    expect(before).toMatchObject({ status: "queued" });
    await runJob(t.platform, job);
    expect(await translationOf(t.platform, id)).toEqual(before);
    const count = await testDb
      .prepare("SELECT count(*) AS count FROM article_translations WHERE article_id = ?")
      .bind(id)
      .first("count");
    expect(count).toBe(1);
  });

  it("決める仕事を積めなくても、判定と抜く処理は失敗にせず、定期実行の手入れで決まる", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const queue: Job[] = [];
    const t = await setUp({
      enqueue: async (jobs) => {
        if (jobs.some((job) => job.type === "decide-translations"))
          throw new Error("queue is busy");
        queue.push(...jobs);
      },
    });
    const [id] = t.ids;
    if (!id) throw new Error("no article");
    for (let job = queue.shift(); job; job = queue.shift()) await runJob(t.platform, job);
    expect(warn).toHaveBeenCalledWith(
      "could not enqueue translation decisions; retrying at the next schedule",
      expect.anything(),
    );
    expect(await translationOf(t.platform, id)).toBeUndefined();

    await runJob(t.platform, { type: "maintain-translations" });
    expect(await translationOf(t.platform, id)).toMatchObject({ status: "queued" });
  });
});
