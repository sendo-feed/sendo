import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { articles } from "../../src/db/schema";
import { runJob } from "../../src/jobs";
import { runFetchFeed } from "../../src/jobs/fetch-feed";
import type { Job } from "../../src/jobs/job";
import type { PageContentExtractor, Platform } from "../../src/platform";
import { testDb } from "../db";
import {
  createTestPlatform,
  createUser,
  fakeArticleAnalysis,
  fakeFetch,
  requestApp,
  subscribeFeed,
} from "../helpers";

/*
 * ページの本文を抜いた・抜けなかったを記録したとき、ページから抜かない記事を取り込んだときに、その記事の
 * 解析を積む（docs/decisions/article-analysis.md の 1）。本番と同じく、取得の仕事、抜く仕事、記事の本文の
 * API から呼ぶ
 */

const ARTICLE_TEXT = "抜いた本文には、記事の内容が段落ごとに書かれています。".repeat(6);
const PAGE_HTML = "<html><body><article><p>ページの本文</p></article></body></html>";

const rss = (links: (string | null)[]) =>
  `<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>Blog</title><link>https://blog.example/</link>
    ${links
      .map(
        (link, i) =>
          `<item><title>記事 ${i}</title>${link === null ? "" : `<link>${link}</link>`}<guid isPermaLink="false">g${i}</guid><description>要約 ${i}</description><content:encoded><![CDATA[<p>フィードの本文 ${i}</p>]]></content:encoded></item>`,
      )
      .join("")}
  </channel></rss>`;

function extractor(html: string | null): PageContentExtractor {
  return {
    async extract() {
      return html === null ? null : { title: "記事", html, textLength: html.length };
    },
  };
}

/** 記事を持つフィードを購読して取得する。null のリンクは URL のない記事 */
async function setUp(links: (string | null)[], options: { extracted?: string | null } = {}) {
  const user = await createUser();
  const fetched = fakeFetch((url) =>
    url.pathname === "/robots.txt"
      ? new Response(null, { status: 404 })
      : links.includes(url.href)
        ? new Response(PAGE_HTML, { headers: { "content-type": "text/html; charset=utf-8" } })
        : new Response(rss(links)),
  );
  const articleAnalysis = fakeArticleAnalysis();
  const overrides: Partial<Platform> = {
    fetch: fetched.fetch,
    articleAnalysis,
    pageContent: extractor(
      options.extracted === undefined ? `<p>${ARTICLE_TEXT}</p>` : options.extracted,
    ),
  };
  const { platform, enqueued } = createTestPlatform(overrides);
  const feed = await subscribeFeed(platform, { userId: user.id });
  await runFetchFeed(platform, feed.id);
  const rows = await platform.db
    .select({ id: articles.id, guid: articles.guid })
    .from(articles)
    .where(eq(articles.feedId, feed.id))
    .all();
  const ids = links.map((_, i) => rows.find((row) => row.guid === `g${i}`)?.id ?? "");
  return { platform, enqueued, user, ids, articleAnalysis };
}

/** 積まれた解析の仕事 */
const analysisJobs = (enqueued: Job[]) =>
  enqueued.filter(
    (job): job is Extract<Job, { type: "analyze-articles" }> => job.type === "analyze-articles",
  );

/** 積まれた、本文を抜く仕事を動かす */
async function runExtraction(platform: Platform, enqueued: Job[]) {
  for (const job of enqueued.filter((job) => job.type === "extract-page")) {
    enqueued.splice(enqueued.indexOf(job), 1);
    await runJob(platform, job);
  }
}

/** 積まれた解析の仕事を動かす */
async function runAnalysis(platform: Platform, enqueued: Job[]) {
  for (const job of analysisJobs(enqueued)) {
    enqueued.splice(enqueued.indexOf(job), 1);
    await runJob(platform, job);
  }
}

const analysisOf = (id: string) =>
  testDb
    .prepare("SELECT candidate_status, embedding_status FROM article_analyses WHERE article_id = ?")
    .bind(id)
    .first();

/** 読む側と同じく、解析の行と世代が同じ候補の行だけ */
const candidatesOf = async (id: string) =>
  (
    await testDb
      .prepare(
        `SELECT c.key FROM article_candidates c JOIN article_analyses a
          ON a.article_id = c.article_id AND a.candidate_generation = c.generation
        WHERE c.article_id = ?`,
      )
      .bind(id)
      .all()
  ).results;

beforeEach(async () => {
  await testDb.exec("DELETE FROM feeds");
  await testDb.exec("UPDATE storage_usage SET limit_bytes = 268435456 WHERE id = 1");
});

describe("記事を取り込んだとき", () => {
  it("URL のある記事は、取り込んだときには積まず、ページを抜いたあとに積む", async () => {
    const t = await setUp([`https://${crypto.randomUUID()}.example.com/posts/0`]);
    const [id = ""] = t.ids;
    expect(analysisJobs(t.enqueued)).toEqual([]);

    await runExtraction(t.platform, t.enqueued);
    expect(analysisJobs(t.enqueued)).toEqual([{ type: "analyze-articles", articleIds: [id] }]);
    await runAnalysis(t.platform, t.enqueued);
    expect(await analysisOf(id)).toMatchObject({
      candidate_status: "done",
      embedding_status: "done",
    });
    expect(await candidatesOf(id)).toEqual([{ key: "rust" }]);
    // 抜いた本文で解析した
    expect(t.articleAnalysis.analyze.mock.calls[0]?.[0].html).toContain("抜いた本文");
  });

  it("URL のない記事は、取り込んだときに積み、フィードの本文で解析する", async () => {
    const t = await setUp([null, `https://${crypto.randomUUID()}.example.com/posts/1`]);
    const [noUrl = ""] = t.ids;
    expect(analysisJobs(t.enqueued)).toEqual([{ type: "analyze-articles", articleIds: [noUrl] }]);

    await runAnalysis(t.platform, t.enqueued);
    expect(await analysisOf(noUrl)).toMatchObject({ candidate_status: "done" });
    expect(t.articleAnalysis.analyze.mock.calls[0]?.[0].html).toContain("フィードの本文 0");
  });

  it("ページから本文を抜けなかったと記録したときも積み、フィードの本文で解析する", async () => {
    const t = await setUp([`https://${crypto.randomUUID()}.example.com/posts/0`], {
      extracted: null,
    });
    const [id = ""] = t.ids;
    await runExtraction(t.platform, t.enqueued);
    expect(analysisJobs(t.enqueued)).toEqual([{ type: "analyze-articles", articleIds: [id] }]);
    await runAnalysis(t.platform, t.enqueued);
    expect(t.articleAnalysis.analyze.mock.calls[0]?.[0].html).toContain("フィードの本文 0");
  });

  it("積めなくても、取得と本文を抜く処理は失敗にしない", async () => {
    const user = await createUser();
    const link = `https://${crypto.randomUUID()}.example.com/posts/0`;
    const fetched = fakeFetch((url) =>
      url.pathname === "/robots.txt"
        ? new Response(null, { status: 404 })
        : url.href === link
          ? new Response(PAGE_HTML, { headers: { "content-type": "text/html; charset=utf-8" } })
          : new Response(rss([null, link])),
    );
    const { platform, enqueued } = createTestPlatform({
      fetch: fetched.fetch,
      articleAnalysis: fakeArticleAnalysis(),
      pageContent: extractor(`<p>${ARTICLE_TEXT}</p>`),
    });
    const enqueue = platform.jobs.enqueue;
    platform.jobs.enqueue = async (jobs) => {
      if (jobs.some((job) => job.type === "analyze-articles")) throw new Error("queue is busy");
      await enqueue(jobs);
    };
    const feed = await subscribeFeed(platform, { userId: user.id });
    expect(await runFetchFeed(platform, feed.id)).toMatchObject({ status: "fetched", inserted: 2 });
    await runExtraction(platform, enqueued);
    expect(await testDb.prepare("SELECT status FROM page_contents").first()).toEqual({
      status: "extracted",
    });
    expect(analysisJobs(enqueued)).toEqual([]);
  });
});

describe("記事を開いたとき", () => {
  it("リクエストの中で本文を抜いたときも、解析の仕事を積む", async () => {
    const t = await setUp([`https://${crypto.randomUUID()}.example.com/posts/0`]);
    const [id = ""] = t.ids;
    t.enqueued.length = 0;

    const res = await requestApp(t.platform, `/api/v1/articles/${id}/content?source=page`, {
      token: t.user.token,
    });
    expect(res.status).toBe(200);
    expect(analysisJobs(t.enqueued)).toEqual([{ type: "analyze-articles", articleIds: [id] }]);
    await runAnalysis(t.platform, t.enqueued);
    expect(await analysisOf(id)).toMatchObject({ candidate_status: "done" });
  });
});

describe("重ねて積まれたとき", () => {
  it("同じ記事の 2 つ目の仕事は、解析し直さない", async () => {
    const t = await setUp([null]);
    const [id = ""] = t.ids;
    await runJob(t.platform, { type: "analyze-articles", articleIds: [id] });
    await runJob(t.platform, { type: "analyze-articles", articleIds: [id] });
    expect(t.articleAnalysis.analyze).toHaveBeenCalledTimes(1);
    expect(
      await testDb
        .prepare("SELECT count(*) AS count FROM article_candidates WHERE article_id = ?")
        .bind(id)
        .first(),
    ).toEqual({ count: 1 });
  });
});
