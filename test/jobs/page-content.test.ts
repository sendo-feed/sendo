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
 * 記事のページの本文（docs/decisions/content.md の 10〜15）。抜く処理（Rust）は差し替えて、
 * それ以外（仕事、DB での読み書き、API）を確かめる。Rust の処理は test/platform/node/ で確かめる。
 */

const PAGE_HTML = "<html><body><article><p>ページの本文</p></article></body></html>";
const ARTICLE_TEXT = "抜いた本文には、記事の内容が段落ごとに書かれています。".repeat(6);

const rss = (links: string[], description = "要約") =>
  `<rss version="2.0"><channel><title>Blog</title><link>https://blog.example/</link>
    ${links.map((link, i) => `<item><title>記事 ${i}</title><link>${link}</link><guid>${i}</guid><description><![CDATA[${description}]]></description></item>`).join("")}
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

async function setUp(options: { extracted?: string | null; feedContent?: string } = {}) {
  const user = await createUser();
  let now = new Date();
  const link = `https://${crypto.randomUUID()}.example.com/posts/1`;
  const page = fakeExtractor(
    options.extracted === undefined
      ? `<p onclick="x()">${ARTICLE_TEXT}<script>alert(1)</script></p><img src="/a.png">`
      : options.extracted,
  );
  const fetched = fakeFetch((url) =>
    url.href === link
      ? new Response(PAGE_HTML, { headers: { "content-type": "text/html; charset=utf-8" } })
      : new Response(rss([link], options.feedContent)),
  );
  const overrides: Partial<Platform> = {
    fetch: fetched.fetch,
    now: () => now,
    pageContent: page.extractor,
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
    ["抜けた", `<p>${ARTICLE_TEXT}</p>`],
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
    const platform = { ...t.platform, pageContent: deletingExtractor(t, `<p>${ARTICLE_TEXT}</p>`) };
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

describe("画像を拡大したあとの本文", () => {
  it("長い画像 URL で上限を超えても、元の画像を残して本文を保存する", async () => {
    const original = `<p>${ARTICLE_TEXT}</p><a href="https://photos.example/view"><img src="https://photos.example/thumb.png"></a>`;
    const t = await setUp({ extracted: original });
    t.page.extractor.images = {
      links: async () => [
        { thumbnail: "https://photos.example/thumb.png", target: "https://photos.example/view" },
      ],
      candidates: async () => [],
      compare: async () => ({ eligible: true, matches: true }),
      replace: async () =>
        `<p>${ARTICLE_TEXT}</p><img src="https://photos.example/${"a".repeat(256 * 1024)}.png">`,
    };
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
    const fetchPage = t.platform.fetch;
    const images = fakeFetch((url) =>
      url.pathname === "/robots.txt" ? new Response(null, { status: 404 }) : new Response(png),
    );
    t.platform.fetch = (input, init) =>
      String(input).startsWith("https://photos.example/")
        ? images.fetch(input, init)
        : fetchPage(input, init);
    await runJob(t.platform, { type: "extract-page", articleId: t.article.id });
    const row = await getPageContent(t.platform.db, t.article.id);
    expect(row?.status).toBe("extracted");
    expect(row?.html).toContain('src="https://photos.example/thumb.png"');
    expect(row?.html).toContain(ARTICLE_TEXT);
  });
});

describe("抜いた本文の長さ", () => {
  it.each([
    [
      "サイトの紹介文だけ",
      "<p>ニュースを紹介するサイトです。公式アカウントもフォローしてください。</p>",
    ],
    [
      "コメント欄の案内だけ",
      "<p>この記事へのコメント（アプリに投稿されたコメントを表示しています）</p>",
    ],
    ["文字参照で長く見える", `<p>${"&#x6587;".repeat(60)}</p>`],
    ["タグと属性で長く見える", `<p title="${"説明".repeat(100)}">案内</p>`],
    ["サニタイズでほとんど消える", `<p>案内</p><script>${"文字".repeat(100)}</script>`],
    ["補助平面の文字も1文字で数える", `<p>${"𠮷".repeat(60)}</p>`],
    ["99文字の本文", `<p>${"文".repeat(99)}</p>`],
    ["空の本文", "<p> \n &nbsp; </p>"],
  ])("%sなら成功として保存せず、仕事ではやり直さない", async (_, html) => {
    const t = await setUp({ extracted: html });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await runJob(t.platform, { type: "extract-page", articleId: t.article.id });
      await runJob(t.platform, { type: "extract-page", articleId: t.article.id });
      expect(await getPageContent(t.platform.db, t.article.id)).toMatchObject({
        status: "failed",
        html: null,
      });
      expect(t.pageFetches()).toBe(1);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("100文字の日本語の本文は、文字参照を戻してから数えて保存する", async () => {
    const t = await setUp({ extracted: `<p>${"&#x6587;".repeat(100)}</p>` });
    await runJob(t.platform, { type: "extract-page", articleId: t.article.id });
    expect(await getPageContent(t.platform.db, t.article.id)).toMatchObject({
      status: "extracted",
    });
  });

  it("短すぎたら404を返し、フィードの本文は残す。1日後に開けば取り直せる", async () => {
    const feedContent = `<p>${ARTICLE_TEXT.repeat(4)}</p>`;
    const t = await setUp({
      extracted: "<p>サイトの紹介</p>",
      feedContent,
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const path = `/api/v1/articles/${t.article.id}/content`;
    try {
      const page = await requestApp(t.platform, `${path}?source=page`, { token: t.user.token });
      expect(page.status).toBe(404);
      expect(await page.json()).toMatchObject({ error: { code: "page_content_unavailable" } });

      const feed = await requestApp(t.platform, path, { token: t.user.token });
      expect(feed.status).toBe(200);
      expect(await feed.json()).toMatchObject({ source: "feed", html: feedContent });

      await requestApp(t.platform, `${path}?source=page`, { token: t.user.token });
      expect(t.pageFetches()).toBe(1);
      t.advance(24 * 60 * 60 * 1000 + 1000);
      t.platform.pageContent = fakeExtractor(`<p>${ARTICLE_TEXT}</p>`).extractor;
      const retry = await requestApp(t.platform, `${path}?source=page`, { token: t.user.token });
      expect(retry.status).toBe(200);
      expect(await getPageContent(t.platform.db, t.article.id)).toMatchObject({
        status: "extracted",
      });
      expect(t.pageFetches()).toBe(2);
    } finally {
      warn.mockRestore();
    }
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
});
