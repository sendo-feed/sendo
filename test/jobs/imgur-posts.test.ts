import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { MAX_CONTENT_BYTES } from "../../src/db/content";
import { getPageContent } from "../../src/db/page-contents";
import { articles } from "../../src/db/schema";
import { runJob } from "../../src/jobs";
import { runFetchFeed } from "../../src/jobs/fetch-feed";
import { findImgurPosts, sanitizeHtml } from "../../src/lib/sanitize-html";
import type { PageContentExtractor, Platform } from "../../src/platform";
import { createPageContentExtractor, loadNativeModule } from "../../src/platform/node/native";
import { NATIVE_MODULE } from "../db";
import { JPEG } from "../fixtures/images";
import { createTestPlatform, createUser, fakeFetch, requestApp, subscribeFeed } from "../helpers";

/*
 * Imgur の公式埋め込みのうち、投稿やアルバムのページを書いた形は、ページの本文で投稿のページを調べて
 * 画像を足す（docs/decisions/content.md の 22）。投稿のページの応答は、#196 の調査で確かめた形を
 * 合成の HTML で写す（実物の HTML は使わない）。
 *
 * 投稿のページへの取得は、同じホスト（imgur.com）へ 1 秒空けて 1 本ずつ動く（決定の 17）ので、
 * 時計を差し替えて進める。robots.txt と順番待ちはプロセスのメモリに持つので、このファイルの中で共有する。
 */

const ARTICLE_TEXT = "抜いた本文には、記事の内容が段落ごとに書かれています。".repeat(6);
const A = 'rel="noopener noreferrer nofollow"';
const ROBOTS = "User-agent: *\nDisallow: /blocked\n";

type Meta = { property?: string; name?: string; content: string };
const postPage = (meta: Meta[]) =>
  `<!doctype html><html><head><title>Imgur</title>${meta
    .map(({ property, name, content }) =>
      property !== undefined
        ? `<meta property="${property}" content="${content}">`
        : `<meta name="${name}" content="${content}">`,
    )
    .join("")}</head><body><div id="root"></div><script>window.x = 1;</script></body></html>`;
const imagePage = (id: string, ext = "jpeg") =>
  postPage([
    { property: "og:type", content: "article" },
    { property: "og:image", content: `https://i.imgur.com/${id}.${ext}?fb` },
    { name: "twitter:image", content: `https://i.imgur.com/${id}h.jpg` },
  ]);
const DEAD =
  '<!doctype html><html><head><title>Imgur</title></head><body><div id="root"></div></body></html>';

/** 投稿のページの応答（パス → 応答）。ない投稿は 404 */
const POSTS: Record<string, (signal: AbortSignal | undefined) => Response | Promise<Response>> = {
  "/Img1": () => html(imagePage("Img1")),
  "/a/Alb2": () => html(imagePage("Cover2", "png")),
  "/gallery/Vid3": () =>
    html(
      postPage([
        { property: "og:type", content: "video.other" },
        { property: "og:image", content: "https://i.imgur.com/Vid3.jpg?fbplay" },
        { property: "og:video", content: "https://i.imgur.com/Vid3.mp4" },
        { name: "twitter:image", content: "https://i.imgur.com/Vid3h.jpg" },
      ]),
    ),
  "/Dead4": () => html(DEAD),
  "/Idless5": () =>
    html(
      postPage([
        { property: "og:type", content: "article" },
        { property: "og:image", content: "https://i.imgur.com/?fb" },
        { name: "twitter:image", content: "https://i.imgur.com/h.jpg" },
      ]),
    ),
  "/Type6": () =>
    html(
      postPage([
        { property: "og:type", content: "website" },
        { property: "og:image", content: "https://i.imgur.com/Type6.jpeg" },
      ]),
    ),
  "/Bad7": () =>
    html(
      postPage([
        { property: "og:type", content: "article" },
        { property: "og:image", content: "http://i.imgur.com/Bad7.jpeg" },
      ]),
    ),
  "/blocked8": () => html(imagePage("blocked8")),
  "/Err9": () => new Response("error", { status: 500 }),
  // 応答を返さない（取得の時間切れ）
  "/Slow10": (signal) =>
    new Promise<Response>((_, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
};

function redirect(path: string) {
  return new Response(null, { status: 301, headers: { location: `https://imgur.com${path}` } });
}

function html(body: string) {
  return new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
}

const embed = (href: string, inner = "") =>
  `<blockquote class="imgur-embed-pub" lang="en" data-id="x" data-context="false"><p><a href="${href}">${inner}</a></p></blockquote>`;

/** 本物の抜く処理（Rust）が本文として選ぶ記事のページ */
const articlePage = (embeds: string[]) =>
  `<html><head><title>記事</title></head><body><article>${embeds
    .map((e) => `<p>${ARTICLE_TEXT}</p>${e}`)
    .join("")}<p>${ARTICLE_TEXT}</p></article></body></html>`;

const rss = (link: string, description: string) =>
  `<rss version="2.0"><channel><title>Blog</title><link>https://blog.example/</link><item><title>記事</title><link>${link}</link><guid>1</guid><description><![CDATA[${description}]]></description></item></channel></rss>`;

async function setUp(options: {
  pageHtml?: string;
  scheme?: "https" | "http";
  extractor?: PageContentExtractor;
  feedContent?: string;
  respond?: (url: URL, init: RequestInit | undefined) => Response | Promise<Response> | undefined;
}) {
  const user = await createUser();
  const link = `${options.scheme ?? "https"}://${crypto.randomUUID()}.example.com/posts/1`;
  const fetched = fakeFetch((url, init) => {
    const custom = options.respond?.(url, init);
    if (custom) return custom;
    if (url.href === link) return html(options.pageHtml ?? articlePage([]));
    if (url.host === "imgur.com") {
      if (url.pathname === "/robots.txt") return new Response(ROBOTS);
      // http は https へ移す（Imgur と同じ）
      if (url.protocol === "http:") {
        return new Response(null, {
          status: 301,
          headers: { location: `https://imgur.com${url.pathname}` },
        });
      }
      const respond = POSTS[url.pathname];
      return respond ? respond(init?.signal ?? undefined) : new Response(null, { status: 404 });
    }
    return new Response(rss(link, options.feedContent ?? "要約"));
  });
  const overrides: Partial<Platform> = {
    fetch: fetched.fetch,
    pageContent: options.extractor ?? createPageContentExtractor(loadNativeModule(NATIVE_MODULE)),
  };
  const { platform } = createTestPlatform(overrides);
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
    user,
    article,
    link,
    /** imgur.com の投稿のページへの取得（robots.txt を除く） */
    postFetches: () =>
      fetched.calls
        .map(({ url }) => new URL(url))
        .filter((url) => url.host === "imgur.com" && url.pathname !== "/robots.txt")
        .map((url) => url.href),
    calls: fetched.calls,
  };
}

/**
 * 差し替えた時計の今。順番待ち（HostGate）は前の取得が終わった時刻をメモリに持つので、テストを
 * またいで時計が戻らないようにする
 */
let clock = Date.now();

/** 抜く仕事を、時計を進めながら動かす（同じホストへの 1 秒の間隔と、取得の期限を待たない） */
async function extractWithClock(platform: Platform, articleId: string) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(clock);
  // Node の AbortSignal.timeout は内部のタイマーを使うため、HostGate と同じ時計に合わせる
  const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("timed out", "TimeoutError")), ms);
    return controller.signal;
  });
  try {
    let settled = false;
    const job = runJob(platform, { type: "extract-page", articleId }).finally(() => {
      settled = true;
    });
    for (let i = 0; i < 2_000 && !settled; i++) {
      // 抜く処理（Rust）と DB は本物の非同期なので、本物のイベントループにも番を回す
      await new Promise((resolve) => setImmediate(resolve));
      await vi.advanceTimersByTimeAsync(100);
    }
    await job;
  } finally {
    clock = Date.now() + 60_000;
    timeout.mockRestore();
    vi.useRealTimers();
  }
}

async function pageContent(t: Awaited<ReturnType<typeof setUp>>) {
  const res = await requestApp(t.platform, `/api/v1/articles/${t.article.id}/content?source=page`, {
    token: t.user.token,
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { html: string }).html;
}

const relay = (url: string) =>
  new RegExp(
    `<img src="/api/v1/images\\?url=${encodeURIComponent(url).replace(/[.?*]/g, "\\$&")}&amp;sig=[\\w-]{22}">`,
  );

describe("Imgur の投稿のページを書いた公式埋め込み（ページの本文）", () => {
  it("画像・アルバム・動画の投稿は、投稿のページを調べて、引用の終わりに画像を 1 枚足す", async () => {
    const t = await setUp({
      pageHtml: articlePage([
        embed("//imgur.com/Img1"),
        embed("https://imgur.com/a/Alb2", "アルバム"),
        embed("//imgur.com/gallery/Vid3"),
      ]),
    });
    await extractWithClock(t.platform, t.article.id);

    const row = await getPageContent(t.platform.db, t.article.id);
    expect(row?.status).toBe("extracted");
    expect(row?.html).toContain(
      `<a href="https://imgur.com/Img1" ${A}>https://imgur.com/Img1</a></p><img src="https://i.imgur.com/Img1.jpeg?fb"></blockquote>`,
    );
    // アルバムは表紙（og:image）。リンクの文字はそのまま
    expect(row?.html).toContain(
      `<a href="https://imgur.com/a/Alb2" ${A}>アルバム</a></p><img src="https://i.imgur.com/Cover2.png?fb"></blockquote>`,
    );
    // 動画は twitter:image（静止画）
    expect(row?.html).toContain(
      `https://imgur.com/gallery/Vid3</a></p><img src="https://i.imgur.com/Vid3h.jpg"></blockquote>`,
    );
    expect(t.postFetches()).toEqual([
      "https://imgur.com/Img1",
      "https://imgur.com/a/Alb2",
      "https://imgur.com/gallery/Vid3",
    ]);
    // 画像そのものは、取り込むときには取らない
    expect(t.calls.some(({ url }) => url.startsWith("https://i.imgur.com/"))).toBe(false);

    // 返すときは中継の URL になり、もう一度サニタイズしても画像は増えない
    const body = await pageContent(t);
    expect(body).toMatch(relay("https://i.imgur.com/Img1.jpeg?fb"));
    expect(body).toMatch(relay("https://i.imgur.com/Cover2.png?fb"));
    expect(body).toMatch(relay("https://i.imgur.com/Vid3h.jpg"));
    expect(body.match(/<img /g)).toHaveLength(3);
    // 保存した本文には手掛かりの class が残らないので、通し直しても画像は増えず、調べる投稿もない
    expect(sanitizeHtml(row?.html ?? "", t.link)).toBe(row?.html);
    expect(findImgurPosts(row?.html ?? "", t.link)).toEqual([]);
  });

  it("http の記事のスキームのない書き方は、http のまま取りにいき、https へのリダイレクトをたどる", async () => {
    const t = await setUp({ scheme: "http", pageHtml: articlePage([embed("//imgur.com/Img1")]) });
    await extractWithClock(t.platform, t.article.id);

    const row = await getPageContent(t.platform.db, t.article.id);
    expect(row?.html).toContain(
      `<a href="http://imgur.com/Img1" ${A}>http://imgur.com/Img1</a></p><img src="https://i.imgur.com/Img1.jpeg?fb"></blockquote>`,
    );
    expect(t.postFetches()).toEqual(["http://imgur.com/Img1", "https://imgur.com/Img1"]);
  });

  it("取れない・使えない投稿は、画像を足さずにリンクだけを残し、本文は保存する", async () => {
    const posts = ["Dead4", "Idless5", "Type6", "Bad7", "blocked8", "Err9", "Slow10", "Missing11"];
    const t = await setUp({ pageHtml: articlePage(posts.map((id) => embed(`//imgur.com/${id}`))) });
    await extractWithClock(t.platform, t.article.id);

    const row = await getPageContent(t.platform.db, t.article.id);
    expect(row?.status).toBe("extracted");
    expect(row?.html).not.toContain("<img");
    for (const id of posts) {
      expect(row?.html).toContain(
        `<a href="https://imgur.com/${id}" ${A}>https://imgur.com/${id}</a>`,
      );
    }
    // robots.txt で禁じられた投稿は取りにいかない。ほかは 1 回ずつ
    expect(t.postFetches()).toEqual(
      posts.filter((id) => id !== "blocked8").map((id) => `https://imgur.com/${id}`),
    );
  });

  it("取る投稿は 12 件まで。同じ投稿（クエリだけが違うものも）は 1 回だけ取り、どの引用にも足す", async () => {
    for (let i = 1; i <= 13; i++) POSTS[`/N${i}`] ??= () => html(imagePage(`N${i}`));
    const embeds = Array.from({ length: 13 }, (_, i) => embed(`//imgur.com/N${i + 1}`));
    embeds.splice(1, 0, embed("https://imgur.com/N1?ref=again"));
    const t = await setUp({ pageHtml: articlePage(embeds) });
    await extractWithClock(t.platform, t.article.id);

    expect(t.postFetches()).toEqual(
      Array.from({ length: 12 }, (_, i) => `https://imgur.com/N${i + 1}`),
    );
    const row = await getPageContent(t.platform.db, t.article.id);
    expect(row?.html?.match(/<img src="https:\/\/i\.imgur\.com\/N1\.jpeg\?fb">/g)).toHaveLength(2);
    expect(row?.html).toContain("https://i.imgur.com/N12.jpeg?fb");
    expect(row?.html).not.toContain("https://i.imgur.com/N13.jpeg");
    expect(row?.html).toContain(`<a href="https://imgur.com/N13" ${A}>https://imgur.com/N13</a>`);
  });

  it("投稿のページを調べたあと、残りの上限で本文の画像（20）も拡大する", async () => {
    const photos = `https://${crypto.randomUUID()}.example.com`;
    const extractor = createPageContentExtractor(loadNativeModule(NATIVE_MODULE));
    extractor.images = {
      links: async () => [{ thumbnail: `${photos}/thumb.jpg`, target: `${photos}/full.jpg` }],
      candidates: async () => [],
      compare: async () => ({ eligible: true, matches: true }),
      replace: async (html, link, full) => html.replace(link.thumbnail, full),
      leadImages: async () => ({ lead: [], later: [] }),
      samePicture: async () => false,
      removeImage: async (html) => html,
    };
    const t = await setUp({
      extractor,
      pageHtml: articlePage([
        embed("//imgur.com/Img1"),
        `<p><a href="${photos}/full.jpg"><img src="${photos}/thumb.jpg"></a></p>`,
      ]),
      respond: (url) => {
        if (url.origin !== photos) return undefined;
        if (url.pathname === "/robots.txt") return new Response(null, { status: 404 });
        return new Response(JPEG, { headers: { "content-type": "image/jpeg" } });
      },
    });
    await extractWithClock(t.platform, t.article.id);

    expect(t.postFetches()).toEqual(["https://imgur.com/Img1"]);
    expect(t.calls.map(({ url }) => url).filter((url) => url.startsWith(photos))).toEqual([
      `${photos}/robots.txt`,
      `${photos}/thumb.jpg`,
      `${photos}/full.jpg`,
    ]);
    const row = await getPageContent(t.platform.db, t.article.id);
    expect(row?.html).toContain('<img src="https://i.imgur.com/Img1.jpeg?fb"></blockquote>');
    expect(row?.html).toContain(`<img src="${photos}/full.jpg">`);
    expect(row?.html).not.toContain("thumb.jpg");
  });

  it("投稿のページで回数の上限（36 回）を使い切ったら、本文の画像（20）は取りにいかない", async () => {
    // どの投稿も、2 回のリダイレクトのあとでページを返す（1 件で 3 回の取得）。12 件で 36 回
    for (let i = 1; i <= 12; i++) {
      POSTS[`/Hop${i}`] ??= () => redirect(`/hop1/Hop${i}`);
      POSTS[`/hop1/Hop${i}`] ??= () => redirect(`/hop2/Hop${i}`);
      POSTS[`/hop2/Hop${i}`] ??= () => html(imagePage(`Hop${i}`));
    }
    const photos = `https://${crypto.randomUUID()}.example.com`;
    const extractor = createPageContentExtractor(loadNativeModule(NATIVE_MODULE));
    extractor.images = {
      links: async () => [{ thumbnail: `${photos}/thumb.jpg`, target: `${photos}/full.jpg` }],
      candidates: async () => [],
      compare: async () => ({ eligible: true, matches: true }),
      replace: async (html, link, full) => html.replace(link.thumbnail, full),
      leadImages: async () => ({ lead: [], later: [] }),
      samePicture: async () => false,
      removeImage: async (html) => html,
    };
    const t = await setUp({
      extractor,
      pageHtml: articlePage([
        ...Array.from({ length: 12 }, (_, i) => embed(`//imgur.com/Hop${i + 1}`)),
        `<p><a href="${photos}/full.jpg"><img src="${photos}/thumb.jpg"></a></p>`,
      ]),
      respond: (url) => {
        if (url.origin !== photos) return undefined;
        if (url.pathname === "/robots.txt") return new Response(null, { status: 404 });
        return new Response(JPEG, { headers: { "content-type": "image/jpeg" } });
      },
    });
    await extractWithClock(t.platform, t.article.id);

    // 期限（45 秒）には届かず、回数で止まる
    expect(t.postFetches().filter((url) => url.includes("/hop2/")).length).toBeGreaterThanOrEqual(
      11,
    );
    expect(t.calls.some(({ url }) => url.startsWith(photos))).toBe(false);
    const row = await getPageContent(t.platform.db, t.article.id);
    expect(row?.status).toBe("extracted");
    expect(row?.html).toContain(`${photos}/thumb.jpg`);
  });

  it("上限は本文の画像（20・21）と分け合う。期限を過ぎたら、残りの投稿も本文の画像も取りにいかない", async () => {
    // どの投稿のページも、応答に 8 秒かかる
    for (let i = 1; i <= 12; i++) {
      POSTS[`/Late${i}`] ??= (signal) =>
        new Promise<Response>((resolve, reject) => {
          const timer = setTimeout(() => resolve(html(imagePage(`Late${i}`))), 8_000);
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(signal.reason);
            },
            { once: true },
          );
        });
    }
    const photos = `https://${crypto.randomUUID()}.example.com`;
    const extractor = createPageContentExtractor(loadNativeModule(NATIVE_MODULE));
    const t = await setUp({
      extractor,
      pageHtml: articlePage([
        ...Array.from({ length: 12 }, (_, i) => embed(`//imgur.com/Late${i + 1}`)),
        `<p><a href="${photos}/view.html"><img src="${photos}/thumb.jpg"></a></p>`,
      ]),
    });
    await extractWithClock(t.platform, t.article.id);

    // 1 件に 9 秒（応答 8 秒と、同じホストへの間隔 1 秒）かかり、45 秒の期限までに 5〜6 件
    const fetched = t.postFetches();
    expect(fetched.length).toBeGreaterThanOrEqual(5);
    expect(fetched.length).toBeLessThan(12);
    // 本文の画像は、22 が使った残り（期限切れ）の中で動くので、取りにいかない
    expect(t.calls.some(({ url }) => url.startsWith(photos))).toBe(false);
    const row = await getPageContent(t.platform.db, t.article.id);
    expect(row?.status).toBe("extracted");
  });
});

describe("Imgur の投稿のページを調べない場合", () => {
  /** 抜いたことにする処理（抜いた HTML をそのまま返す） */
  const fakeExtractor = (extracted: string): PageContentExtractor => ({
    async extract() {
      return { title: "記事", html: extracted, textLength: extracted.length };
    },
  });

  it("サニタイズしたあとで 100 文字に満たない本文では、取りにいかない", async () => {
    const t = await setUp({ extractor: fakeExtractor(`<p>短い</p>${embed("//imgur.com/Img1")}`) });
    await extractWithClock(t.platform, t.article.id);

    expect((await getPageContent(t.platform.db, t.article.id))?.status).toBe("failed");
    expect(t.postFetches()).toEqual([]);
  });

  it.each([
    { over: 0, added: true },
    { over: 1, added: false },
  ])("画像を足した本文が上限を $over バイト超えるなら、足す: $added", async ({ over, added }) => {
    const id = `Long${over}${"x".repeat(300)}`;
    POSTS[`/${id}`] ??= () => html(imagePage(id));
    const post = `https://imgur.com/${id}`;
    const images = new Map([[post, `https://i.imgur.com/${id}.jpeg?fb`]]);
    const extractedWith = (n: number) =>
      `<p>${ARTICLE_TEXT}</p>${embed(`//imgur.com/${id}`)}<p>${"a".repeat(n)}</p>`;
    const size = (extracted: string, withImages: boolean) =>
      new TextEncoder().encode(
        sanitizeHtml(
          extracted,
          "https://blog.example.com/",
          withImages ? { imgurPostImages: images } : {},
        ),
      ).byteLength;
    // 足したあとの本文が、ちょうど上限（＋ over バイト）になるように埋める
    const extracted = extractedWith(MAX_CONTENT_BYTES + over - size(extractedWith(0), true));
    expect(size(extracted, true)).toBe(MAX_CONTENT_BYTES + over);
    expect(size(extracted, false)).toBeLessThanOrEqual(MAX_CONTENT_BYTES);
    const t = await setUp({ extractor: fakeExtractor(extracted) });
    await extractWithClock(t.platform, t.article.id);

    expect(t.postFetches()).toEqual([post]);
    const row = await getPageContent(t.platform.db, t.article.id);
    expect(row?.status).toBe("extracted");
    expect(row?.html?.includes(`<img src="https://i.imgur.com/${id}.jpeg?fb">`)).toBe(added);
    expect(row?.html).toContain(`>${post}</a>`);
  });

  it("フィードの本文では、取りにいかない（URL の文字だけ）", async () => {
    const t = await setUp({ feedContent: `<p>${ARTICLE_TEXT}</p>${embed("//imgur.com/Img1")}` });
    const res = await requestApp(t.platform, `/api/v1/articles/${t.article.id}/content`, {
      token: t.user.token,
    });
    const body = ((await res.json()) as { html: string }).html;
    expect(body).toContain(`<a href="https://imgur.com/Img1" ${A}>https://imgur.com/Img1</a>`);
    expect(body).not.toContain("<img");
    expect(t.postFetches()).toEqual([]);
  });

  it("直リンクの形の引用では、取りにいかない", async () => {
    const t = await setUp({
      pageHtml: articlePage([embed("https://i.imgur.com/Img1.jpeg", "View post on imgur.com")]),
    });
    await extractWithClock(t.platform, t.article.id);

    expect(t.postFetches()).toEqual([]);
    expect((await getPageContent(t.platform.db, t.article.id))?.html).toContain(
      '<img src="https://i.imgur.com/Img1.jpeg"></blockquote>',
    );
  });
});
