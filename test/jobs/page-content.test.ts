import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import {
  getPageContent,
  recordExtractedPageContent,
  recordFailedPageContent,
} from "../../src/db/page-contents";
import { articles } from "../../src/db/schema";
import { runJob } from "../../src/jobs";
import { runFetchFeed } from "../../src/jobs/fetch-feed";
import type { PageContentExtractor, Platform } from "../../src/platform";
import { createTestPlatform, createUser, fakeFetch, requestApp, subscribeFeed } from "../helpers";

/*
 * 記事のページの本文（docs/decisions/content.md の 10〜15）。抜く処理（Rust）はコンテナ版だけが持つので、
 * ここでは差し替えて、2 つの版で共有する部分（仕事、D1 での読み書き、API）を確かめる。
 */

const PAGE_HTML = "<html><body><article><p>ページの本文</p></article></body></html>";

const rss = (...links: string[]) =>
  `<rss version="2.0"><channel><title>Blog</title><link>https://blog.example/</link>
    ${links.map((link, i) => `<item><title>記事 ${i}</title><link>${link}</link><guid>${i}</guid><description>要約</description></item>`).join("")}
  </channel></rss>`;

/** 抜いたことにする処理。受け取った URL を記録する */
function fakeExtractor(html: string | null) {
  const calls: string[] = [];
  const extractor: PageContentExtractor = {
    async extract({ url }) {
      calls.push(url);
      return html === null ? null : { title: "記事", html, textLength: html.length };
    },
  };
  return { extractor, calls };
}

async function setUp(options: { extracted?: string | null; pageContent?: boolean } = {}) {
  const user = await createUser();
  let now = new Date();
  const link = `https://${crypto.randomUUID()}.example.com/posts/1`;
  const page = fakeExtractor(
    options.extracted === undefined
      ? '<p onclick="x()">抜いた本文<script>alert(1)</script></p><img src="/a.png">'
      : options.extracted,
  );
  const fetched = fakeFetch((url) =>
    url.href === link
      ? new Response(PAGE_HTML, { headers: { "content-type": "text/html; charset=utf-8" } })
      : new Response(rss(link)),
  );
  const overrides: Partial<Platform> = {
    fetch: fetched.fetch,
    now: () => now,
    ...(options.pageContent !== false && { pageContent: page.extractor }),
  };
  const { platform, enqueued } = createTestPlatform(overrides);
  const feed = await subscribeFeed(platform, { userId: user.id });
  await runFetchFeed(platform, feed.id);
  const article = await platform.db
    .select()
    .from(articles)
    .where(eq(articles.feedId, feed.id))
    .get();
  if (!article) throw new Error("no article");
  return {
    platform,
    enqueued,
    user,
    article,
    link,
    page,
    pageFetches: () => fetched.calls.filter((call) => call.url === link).length,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
}

describe("ページの本文の行", () => {
  it("抜けた行は、先に書いたほうを残す。抜けなかった記録は、抜けた行で上書きする", async () => {
    const t = await setUp();
    const { db } = t.platform;
    const now = new Date();
    const articleId = t.article.id;

    await recordFailedPageContent(db, { articleId, now });
    expect(await getPageContent(db, articleId)).toMatchObject({ status: "failed", html: null });

    expect(await recordExtractedPageContent(db, { articleId, html: "<p>一</p>", now })).toBe(
      "<p>一</p>",
    );
    // あとから抜いたほうは残らず、先に書いた本文が返る
    expect(await recordExtractedPageContent(db, { articleId, html: "<p>二</p>", now })).toBe(
      "<p>一</p>",
    );
    // 抜けた行は、抜けなかった記録で上書きしない
    await recordFailedPageContent(db, { articleId, now });
    expect(await getPageContent(db, articleId)).toMatchObject({
      status: "extracted",
      html: "<p>一</p>",
    });
  });

  it("記事の行が消えると、連鎖で消える", async () => {
    const t = await setUp();
    await runJob(t.platform, { type: "extract-page", articleId: t.article.id });
    expect(await getPageContent(t.platform.db, t.article.id)).toBeDefined();

    await t.platform.db.delete(articles).where(eq(articles.id, t.article.id)).run();
    expect(await getPageContent(t.platform.db, t.article.id)).toBeUndefined();
  });
});

describe("抜いている間に記事が消えたとき", () => {
  /** 抜いている間に、記事の行を消す（片付けと重なった場合） */
  const deletingExtractor = (t: Awaited<ReturnType<typeof setUp>>, html: string | null) => ({
    async extract() {
      await t.platform.db.delete(articles).where(eq(articles.id, t.article.id)).run();
      return html === null ? null : { title: "記事", html, textLength: html.length };
    },
  });

  it.each([
    ["抜けた", "<p>本文</p>"],
    ["抜けなかった", null],
  ])("%s結果を書かずに終える（仕事は例外にしない）", async (_, html) => {
    const t = await setUp();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const platform = { ...t.platform, pageContent: deletingExtractor(t, html) };
    await runJob(platform, { type: "extract-page", articleId: t.article.id });
    expect(await getPageContent(t.platform.db, t.article.id)).toBeUndefined();
    vi.restoreAllMocks();
  });

  it("開いたときに抜いていたら、404（page_content_unavailable）を返す（500 にしない）", async () => {
    const t = await setUp();
    const platform = { ...t.platform, pageContent: deletingExtractor(t, "<p>本文</p>") };
    const res = await requestApp(platform, `/api/v1/articles/${t.article.id}/content?source=page`, {
      token: t.user.token,
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: "page_content_unavailable" } });
  });
});

describe("取り込んだときに抜く", () => {
  it("取得の仕事は、新しい記事ごとに、ページから抜く仕事を積む", async () => {
    const t = await setUp();
    expect(t.enqueued).toContainEqual({ type: "extract-page", articleId: t.article.id });
  });

  it("ページから抜けない版（Cloudflare 版）では、抜く仕事を積まない", async () => {
    const t = await setUp({ pageContent: false });
    expect(t.enqueued.filter((job) => job.type === "extract-page")).toEqual([]);
  });

  it("抜く仕事は、抜いてサニタイズした本文を行に入れる。2 回目は取りにいかない", async () => {
    const t = await setUp();
    await runJob(t.platform, { type: "extract-page", articleId: t.article.id });
    await runJob(t.platform, { type: "extract-page", articleId: t.article.id });

    const row = await getPageContent(t.platform.db, t.article.id);
    expect(row?.status).toBe("extracted");
    expect(row?.html).toContain("抜いた本文");
    expect(row?.html).not.toContain("<script");
    expect(row?.html).not.toContain("onclick");
    // 抜く処理には、取ってきたページの URL を渡す
    expect(t.page.calls).toEqual([t.link]);
    expect(t.pageFetches()).toBe(1);

    // 開いたときは、取りにいかずに行から返す
    const res = await requestApp(
      t.platform,
      `/api/v1/articles/${t.article.id}/content?source=page`,
      {
        token: t.user.token,
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { html: string; source: string };
    expect(body.source).toBe("page");
    expect(body.html).toContain("抜いた本文");
    // 画像は中継の URL に書き換える
    expect(body.html).toContain("/api/v1/images?");
    expect(t.pageFetches()).toBe(1);
  });

  it("抜けなければ記録し、仕事ではやり直さない", async () => {
    const t = await setUp({ extracted: null });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await runJob(t.platform, { type: "extract-page", articleId: t.article.id });
    await runJob(t.platform, { type: "extract-page", articleId: t.article.id });
    expect(await getPageContent(t.platform.db, t.article.id)).toMatchObject({ status: "failed" });
    expect(t.pageFetches()).toBe(1);
    vi.restoreAllMocks();
  });

  it("消えた記事の仕事は、何もしない", async () => {
    const t = await setUp();
    await t.platform.db.delete(articles).where(eq(articles.id, t.article.id)).run();
    await runJob(t.platform, { type: "extract-page", articleId: t.article.id });
    expect(t.pageFetches()).toBe(0);
  });
});

describe("開いたときに抜く（API）", () => {
  it("まだ抜いていなければ、そのリクエストの中で抜いて返す", async () => {
    const t = await setUp();
    const path = `/api/v1/articles/${t.article.id}/content?source=page`;

    const res = await requestApp(t.platform, path, { token: t.user.token });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ source: "page" });
    await requestApp(t.platform, path, { token: t.user.token });
    expect(t.pageFetches()).toBe(1);
  });

  it("抜けなければ 404 にし、1 日たってから取りにいき直す", async () => {
    const t = await setUp({ extracted: null });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const path = `/api/v1/articles/${t.article.id}/content?source=page`;

    const res = await requestApp(t.platform, path, { token: t.user.token });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: "page_content_unavailable" } });
    await requestApp(t.platform, path, { token: t.user.token });
    expect(t.pageFetches()).toBe(1);

    t.advance(24 * 60 * 60 * 1000 + 1000);
    await requestApp(t.platform, path, { token: t.user.token });
    expect(t.pageFetches()).toBe(2);
    vi.restoreAllMocks();
  });

  it("ほかの人の記事は、ページを取りにいかずに 404", async () => {
    const t = await setUp();
    const other = await createUser();
    const res = await requestApp(
      t.platform,
      `/api/v1/articles/${t.article.id}/content?source=page`,
      {
        token: other.token,
      },
    );
    expect(res.status).toBe(404);
    expect(t.pageFetches()).toBe(0);
  });

  it("抜く処理を持たない版（Cloudflare 版）では 501 を返し、使える機能の一覧でも false", async () => {
    const t = await setUp({ pageContent: false });

    const res = await requestApp(
      t.platform,
      `/api/v1/articles/${t.article.id}/content?source=page`,
      {
        token: t.user.token,
      },
    );
    expect(res.status).toBe(501);
    expect(await res.json()).toMatchObject({ error: { code: "feature_unavailable" } });
    expect(t.pageFetches()).toBe(0);

    const features = await requestApp(t.platform, "/api/v1/features", { token: t.user.token });
    expect(await features.json()).toEqual({ pageContent: false });
  });

  it("抜く処理を持つ版（コンテナ版）では、使える機能の一覧で true", async () => {
    const t = await setUp();
    const features = await requestApp(t.platform, "/api/v1/features", { token: t.user.token });
    expect(await features.json()).toEqual({ pageContent: true });
  });
});
