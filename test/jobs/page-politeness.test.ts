import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getPageContent } from "../../src/db/page-contents";
import { articles } from "../../src/db/schema";
import { runJob } from "../../src/jobs";
import { runFetchFeed } from "../../src/jobs/fetch-feed";
import type { PageContentExtractor } from "../../src/platform";
import { createTestPlatform, createUser, fakeFetch, requestApp, subscribeFeed } from "../helpers";

/*
 * 記事のページを取りにいくときの行儀（docs/decisions/content.md の 17、18）。同じホストへは 1 本ずつ
 * 取りにいき、robots.txt を守る。抜く処理（Rust）は差し替える。
 */

const PAGE_HTML = "<html><body><article><p>ページの本文</p></article></body></html>";

const rss = (...links: string[]) =>
  `<rss version="2.0"><channel><title>Blog</title><link>https://blog.example/</link>
    ${links.map((link, i) => `<item><title>記事 ${i}</title><link>${link}</link><guid>${i}</guid><description>要約</description></item>`).join("")}
  </channel></rss>`;

const extractor: PageContentExtractor = {
  async extract() {
    const text = "抜いた本文には、記事の内容が段落ごとに書かれています。".repeat(6);
    return { title: "記事", html: `<p>${text}</p>`, textLength: text.length };
  },
};

const html = () => new Response(PAGE_HTML, { headers: { "content-type": "text/html" } });

/**
 * 同じホストに記事を count 件置いたフィードを購読して取り込む。robots.txt とページの応答を差し替え、
 * 取りにいった URL と、記事のホストへ同時に取りにいった数の最大を記録する
 */
async function setUpSite(options: {
  count?: number;
  robots?: (url: URL) => Response;
  page?: (url: URL) => Response | Promise<Response>;
}) {
  const user = await createUser();
  const host = `${crypto.randomUUID()}.example.com`;
  const links = Array.from({ length: options.count ?? 1 }, (_, i) => `https://${host}/posts/${i}`);
  const feedUrl = `https://feeds.${host}/feed.xml`;
  let running = 0;
  let most = 0;
  const fetched = fakeFetch(async (url) => {
    if (url.href === feedUrl) return new Response(rss(...links));
    if (url.pathname === "/robots.txt") {
      return options.robots?.(url) ?? new Response("", { status: 404 });
    }
    if (url.host !== host) return options.page?.(url) ?? html();
    running++;
    most = Math.max(most, running);
    // 応答が返るまでに少しかかるようにして、重なれば見えるようにする
    await new Promise((resolve) => setTimeout(resolve, 20));
    running--;
    return options.page?.(url) ?? html();
  });
  const { platform } = createTestPlatform({ fetch: fetched.fetch, pageContent: extractor });
  const feed = await subscribeFeed(platform, { userId: user.id, url: feedUrl });
  await runFetchFeed(platform, feed.id);
  const rows = await platform.db.select().from(articles).where(eq(articles.feedId, feed.id)).all();
  const first = rows[0];
  if (!first) throw new Error("no article");
  return {
    platform,
    user,
    host,
    articleId: first.id,
    articleIds: rows.map((row) => row.id),
    /** 記事のページの URL（パス）から、記事の ID を引く */
    idOf: (path: string) => rows.find((row) => row.url === `https://${host}${path}`)?.id ?? "",
    calls: () => fetched.calls.map((call) => call.url),
    most: () => most,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("同じホストへは 1 本ずつ（決定の 17）", () => {
  it("同じホストの記事をまとめて抜いても、そのホストへは 1 本ずつ取りにいく", async () => {
    const t = await setUpSite({ count: 3 });
    expect(t.articleIds).toHaveLength(3);
    await Promise.all(
      t.articleIds.map((articleId) => runJob(t.platform, { type: "extract-page", articleId })),
    );
    for (const articleId of t.articleIds) {
      expect(await getPageContent(t.platform.db, articleId)).toMatchObject({ status: "extracted" });
    }
    expect(t.most()).toBe(1);
    // robots.txt は 1 回だけ取りにいく
    expect(t.calls().filter((url) => url.endsWith("/robots.txt"))).toEqual([
      `https://${t.host}/robots.txt`,
    ]);
  });

  it("開いたときの抜き取りも、抜く仕事と重ならない", async () => {
    const t = await setUpSite({ count: 2 });
    const [job, open] = t.articleIds;
    await Promise.all([
      runJob(t.platform, { type: "extract-page", articleId: job ?? "" }),
      requestApp(t.platform, `/api/v1/articles/${open}/content?source=page`, {
        token: t.user.token,
      }),
    ]);
    expect(t.most()).toBe(1);
    expect(t.calls().filter((url) => url.includes("/posts/"))).toHaveLength(2);
  });

  it("抜く仕事が順番を待っている記事を読者が開いたら、ほかの抜く仕事より先に取りにいく", async () => {
    let release = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = () => {};
    const firstStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const t = await setUpSite({
      count: 3,
      page: async (url) => {
        if (url.pathname === "/posts/0") {
          started();
          await blocked;
        }
        return html();
      },
    });
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    // 0 を取りにいっている間に、1 と 2 の抜く仕事が順番を待つ
    const jobs = ["/posts/0", "/posts/1", "/posts/2"].map((path) =>
      runJob(t.platform, { type: "extract-page", articleId: t.idOf(path) }),
    );
    await firstStarted;
    await wait(100);
    // 読者が 2 を開く。2 の抜く仕事は、読者の位置へ並び直す
    const opened = requestApp(
      t.platform,
      `/api/v1/articles/${t.idOf("/posts/2")}/content?source=page`,
      { token: t.user.token },
    );
    await wait(100);
    release();
    await Promise.all([...jobs, opened]);

    expect((await opened).status).toBe(200);
    expect(t.calls().filter((url) => url.includes("/posts/"))).toEqual([
      `https://${t.host}/posts/0`,
      `https://${t.host}/posts/2`,
      `https://${t.host}/posts/1`,
    ]);
  });
});

describe("robots.txt（決定の 18）", () => {
  it("断られたページは取りにいかず、抜けなかったものとして記録する。理由はログにだけ出す", async () => {
    const t = await setUpSite({
      robots: () =>
        new Response("User-agent: *\nAllow: /\n\nUser-agent: Sendo\nDisallow: /posts/\n"),
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await runJob(t.platform, { type: "extract-page", articleId: t.articleId });

    expect(await getPageContent(t.platform.db, t.articleId)).toMatchObject({ status: "failed" });
    expect(t.calls().filter((url) => url.includes("/posts/"))).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      "could not fetch the article page",
      expect.objectContaining({ code: "robots_disallowed" }),
    );

    // API は理由を出さずに 404（page_content_unavailable）を返し、取りにいき直さない
    const res = await requestApp(
      t.platform,
      `/api/v1/articles/${t.articleId}/content?source=page`,
      { token: t.user.token },
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("page_content_unavailable");
    expect(body.error.message).not.toContain("robots");
  });

  it("開いたときの抜き取りでも守る", async () => {
    const t = await setUpSite({ robots: () => new Response("User-agent: *\nDisallow: /\n") });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await requestApp(
      t.platform,
      `/api/v1/articles/${t.articleId}/content?source=page`,
      { token: t.user.token },
    );
    expect(res.status).toBe(404);
    expect(t.calls().filter((url) => url.includes("/posts/"))).toEqual([]);
  });

  it.each([429, 503])(
    "robots.txt が %i なら、取りにいかずに抜けなかったものとして記録する",
    async (status) => {
      const t = await setUpSite({ robots: () => new Response("oops", { status }) });
      vi.spyOn(console, "warn").mockImplementation(() => {});
      await runJob(t.platform, { type: "extract-page", articleId: t.articleId });
      expect(await getPageContent(t.platform.db, t.articleId)).toMatchObject({ status: "failed" });
      expect(t.calls().filter((url) => url.includes("/posts/"))).toEqual([]);
    },
  );

  it("robots.txt がなければ（4xx）、取りにいく", async () => {
    const t = await setUpSite({ robots: () => new Response("", { status: 403 }) });
    await runJob(t.platform, { type: "extract-page", articleId: t.articleId });
    expect(await getPageContent(t.platform.db, t.articleId)).toMatchObject({ status: "extracted" });
  });

  it("リダイレクトの行き先も、行き先のサイトの robots.txt で確かめる", async () => {
    const target = `https://${crypto.randomUUID()}.example.org`;
    const t = await setUpSite({
      // 記事のサイトは許し、行き先のサイトは Sendo を断る
      robots: (url) =>
        url.origin === target
          ? new Response("User-agent: *\nAllow: /\n\nUser-agent: sendo\nDisallow: /article\n")
          : new Response("", { status: 404 }),
      page: (url) =>
        !url.pathname.startsWith("/posts/")
          ? html()
          : new Response(null, { status: 301, headers: { location: `${target}/article` } }),
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await runJob(t.platform, { type: "extract-page", articleId: t.articleId });
    expect(await getPageContent(t.platform.db, t.articleId)).toMatchObject({ status: "failed" });
    expect(t.calls()).toContain(`${target}/robots.txt`);
    expect(t.calls()).not.toContain(`${target}/article`);
  });

  it("フィードの取得では、robots.txt を見ない", async () => {
    const t = await setUpSite({ robots: () => new Response("User-agent: *\nDisallow: /\n") });
    // 取り込みは済んでいて、フィードのホストの robots.txt は取りにいっていない
    expect(t.calls().some((url) => url.startsWith(`https://feeds.${t.host}/robots.txt`))).toBe(
      false,
    );
  });
});
