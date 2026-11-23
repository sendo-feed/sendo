import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getArticleLanguage } from "../../src/db/article-languages";
import { articles } from "../../src/db/schema";
import { runJob } from "../../src/jobs";
import { runFetchFeed } from "../../src/jobs/fetch-feed";
import type { Job } from "../../src/jobs/job";
import type { LanguageDetectionResult, PageContentExtractor, Platform } from "../../src/platform";
import { testDb } from "../db";
import { createTestPlatform, createUser, fakeFetch, requestApp, subscribeFeed } from "../helpers";

/*
 * 記事を取り込んだとき、ページを抜き終えたときに、その記事の言語の判定を積む
 * （docs/decisions/jobs.md の 13、article-language.md の 5）。本番と同じく、取得の仕事、抜く仕事、
 * 記事の本文の API から呼ぶ
 */

const ARTICLE_TEXT = "抜いた本文には、記事の内容が段落ごとに書かれています。".repeat(6);
const PAGE_HTML = "<html><body><article><p>ページの本文</p></article></body></html>";

const rss = (links: string[]) =>
  `<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>Blog</title><link>https://blog.example/</link>
    ${links.map((link, i) => `<item><title>記事 ${i}</title><link>${link}</link><guid>${i}</guid><description>要約 ${i}</description><content:encoded><![CDATA[<p>${ARTICLE_TEXT} ${i}</p>]]></content:encoded></item>`).join("")}
  </channel></rss>`;

const detected: LanguageDetectionResult = {
  language: "en",
  status: "detected",
  score: 1,
  margin: 1,
  inputHash: "a".repeat(64),
};

function detector() {
  return {
    detector: "test",
    pipelineRevision: 1,
    detect: vi.fn(async (_html: string): Promise<LanguageDetectionResult> => detected),
  };
}

function extractor(html: string | null): PageContentExtractor {
  return {
    async extract() {
      return html === null ? null : { title: "記事", html, textLength: html.length };
    },
  };
}

/** count 件の記事を持つフィードを購読して取得する */
async function setUp(count: number, options: { extracted?: string | null } = {}) {
  const user = await createUser();
  // 同じホストへは 1 秒おきにしか取りにいかないので、記事ごとにホストを分ける（content.md の 17）
  const links = Array.from(
    { length: count },
    (_, i) => `https://${crypto.randomUUID()}.example.com/posts/${i}`,
  );
  const fetched = fakeFetch((url) =>
    url.pathname === "/robots.txt"
      ? new Response(null, { status: 404 })
      : links.includes(url.href)
        ? new Response(PAGE_HTML, { headers: { "content-type": "text/html; charset=utf-8" } })
        : new Response(rss(links)),
  );
  const languageDetection = detector();
  const overrides: Partial<Platform> = {
    fetch: fetched.fetch,
    languageDetection,
    pageContent: extractor(
      options.extracted === undefined ? `<p>${ARTICLE_TEXT}</p>` : options.extracted,
    ),
  };
  const { platform, enqueued } = createTestPlatform(overrides);
  const feed = await subscribeFeed(platform, { userId: user.id });
  await runFetchFeed(platform, feed.id);
  const ids = (
    await platform.db
      .select({ id: articles.id })
      .from(articles)
      .where(eq(articles.feedId, feed.id))
      .all()
  ).map((row) => row.id);
  return { platform, enqueued, user, ids, languageDetection };
}

/** 積まれた、記事を指定した言語の判定の仕事 */
const detectionJobs = (enqueued: Job[]) =>
  enqueued.filter(
    (job): job is Extract<Job, { type: "detect-article-languages" }> =>
      job.type === "detect-article-languages" && job.articleIds !== undefined,
  );

/** 積まれた判定の仕事を、続きも含めてすべて動かす */
async function runDetection(platform: Platform, enqueued: Job[]) {
  for (let job = detectionJobs(enqueued)[0]; job; job = detectionJobs(enqueued)[0]) {
    enqueued.splice(enqueued.indexOf(job), 1);
    await runJob(platform, job);
  }
}

beforeEach(async () => {
  await testDb.exec("DELETE FROM feeds");
  await testDb.exec("UPDATE storage_usage SET limit_bytes = 268435456 WHERE id = 1");
});

describe("記事を取り込んだとき", () => {
  it("取り込んだ記事の判定の仕事を積み、動かすと定期実行を待たずに feed の判定が入る", async () => {
    const t = await setUp(3);
    const jobs = detectionJobs(t.enqueued);
    expect(jobs).toEqual([{ type: "detect-article-languages", articleIds: t.ids }]);

    await runDetection(t.platform, t.enqueued);
    for (const id of t.ids) {
      expect(await getArticleLanguage(t.platform.db, id, "feed")).toMatchObject({
        language: "en",
        status: "detected",
      });
    }
  });

  it("11 件なら、10 件と 1 件の仕事に分けて積み、すべて動かすと 11 件とも判定が入る", async () => {
    const t = await setUp(11);
    expect(detectionJobs(t.enqueued).map((job) => job.articleIds?.length)).toEqual([10, 1]);

    await runDetection(t.platform, t.enqueued);
    for (const id of t.ids) {
      expect(await getArticleLanguage(t.platform.db, id, "feed")).toBeDefined();
    }
  });

  it("判定の仕事を積めなくても、取り込みは失敗にせず、定期実行の仕事で判定が入る", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const user = await createUser();
    const link = `https://${crypto.randomUUID()}.example.com/posts/0`;
    const fetched = fakeFetch(() => new Response(rss([link])));
    const enqueued: Job[] = [];
    const { platform } = createTestPlatform({
      fetch: fetched.fetch,
      languageDetection: detector(),
      jobs: {
        async enqueue(jobs) {
          if (jobs.some((job) => job.type === "detect-article-languages")) {
            throw new Error("queue is busy");
          }
          enqueued.push(...jobs);
        },
      },
    });
    const feed = await subscribeFeed(platform, { userId: user.id });
    expect((await runFetchFeed(platform, feed.id)).status).not.toBe("failed");
    const article = await platform.db
      .select({ id: articles.id })
      .from(articles)
      .where(eq(articles.feedId, feed.id))
      .get();
    if (!article) throw new Error("no article");
    expect(warn).toHaveBeenCalled();
    expect(await getArticleLanguage(platform.db, article.id, "feed")).toBeUndefined();

    await runJob(platform, { type: "detect-article-languages" });
    expect(await getArticleLanguage(platform.db, article.id, "feed")).toBeDefined();
  });
});

describe("ページを抜き終えたとき", () => {
  it("抜く仕事で抜けたら、その記事の判定の仕事を積み、動かすと page の判定が入る", async () => {
    const t = await setUp(1);
    await runDetection(t.platform, t.enqueued);
    const [id] = t.ids;
    if (!id) throw new Error("no article");

    await runJob(t.platform, { type: "extract-page", articleId: id });
    expect(detectionJobs(t.enqueued)).toEqual([
      { type: "detect-article-languages", articleIds: [id] },
    ]);
    await runDetection(t.platform, t.enqueued);
    expect(await getArticleLanguage(t.platform.db, id, "page")).toMatchObject({
      language: "en",
      status: "detected",
    });
  });

  it("抜けなかったら、page の判定の仕事を積まない", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = await setUp(1, { extracted: null });
    await runDetection(t.platform, t.enqueued);
    const [id] = t.ids;
    if (!id) throw new Error("no article");

    await runJob(t.platform, { type: "extract-page", articleId: id });
    expect(detectionJobs(t.enqueued)).toEqual([]);
  });

  it("開いたときにリクエストの中で抜いたときも、判定の仕事を積む", async () => {
    const t = await setUp(1);
    await runDetection(t.platform, t.enqueued);
    const [id] = t.ids;
    if (!id) throw new Error("no article");

    const res = await requestApp(t.platform, `/api/v1/articles/${id}/content?source=page`, {
      token: t.user.token,
    });
    expect(res.status).toBe(200);
    expect(detectionJobs(t.enqueued)).toEqual([
      { type: "detect-article-languages", articleIds: [id] },
    ]);
    await runDetection(t.platform, t.enqueued);
    expect(await getArticleLanguage(t.platform.db, id, "page")).toBeDefined();
  });
});

describe("重なりと容量", () => {
  it("同じ記事の判定の仕事と定期実行の仕事を両方動かしても、判定の行は入力元ごとに 1 つで、結果は変わらない", async () => {
    const t = await setUp(2);
    await runJob(t.platform, { type: "detect-article-languages" });
    const before = await Promise.all(
      t.ids.map((id) => getArticleLanguage(t.platform.db, id, "feed")),
    );
    await runDetection(t.platform, t.enqueued);
    await runJob(t.platform, { type: "detect-article-languages" });

    expect(t.languageDetection.detect).toHaveBeenCalledTimes(2);
    const count = await testDb
      .prepare(
        `SELECT count(*) AS count FROM article_languages WHERE article_id IN ('${t.ids.join("','")}')`,
      )
      .first("count");
    expect(count).toBe(2);
    expect(
      await Promise.all(t.ids.map((id) => getArticleLanguage(t.platform.db, id, "feed"))),
    ).toEqual(before);
  });

  /** 10 件の記事のページも抜けて、feed と page で 20 の入力元が残る、取り込んだときの仕事 */
  async function twentySources() {
    const t = await setUp(10);
    for (const id of t.ids) await runJob(t.platform, { type: "extract-page", articleId: id });
    const first = detectionJobs(t.enqueued)[0];
    t.enqueued.length = 0;
    if (!first) throw new Error("no job");
    return { ...t, first };
  }

  it("1 つの仕事で 10 件を超えると、同じ記事の続きの仕事を積み、すべて動かすと全部入る", async () => {
    const t = await twentySources();
    await runJob(t.platform, t.first);
    expect(detectionJobs(t.enqueued)).toEqual([
      {
        type: "detect-article-languages",
        articleIds: t.first.articleIds,
        after: expect.any(Object),
      },
    ]);
    await runDetection(t.platform, t.enqueued);
    for (const id of t.ids) {
      expect(await getArticleLanguage(t.platform.db, id, "feed")).toBeDefined();
      expect(await getArticleLanguage(t.platform.db, id, "page")).toBeDefined();
    }
  });

  it("容量の上限で保存できなければ、続きを積まず、定期実行の仕事で入る", async () => {
    const t = await twentySources();
    await runJob({ ...t.platform, retentionConfig: { maxBytes: 0 } }, t.first);
    expect(t.enqueued).toEqual([]);
    expect(await getArticleLanguage(t.platform.db, t.ids[0] ?? "", "feed")).toBeUndefined();

    // 容量が空いたあとの定期実行（全体を拾う仕事と、その続き）
    let job: Job | undefined = { type: "detect-article-languages" };
    while (job) {
      await runJob(t.platform, job);
      job = t.enqueued.shift();
    }
    for (const id of t.ids) {
      expect(await getArticleLanguage(t.platform.db, id, "feed")).toBeDefined();
      expect(await getArticleLanguage(t.platform.db, id, "page")).toBeDefined();
    }
  });
});
