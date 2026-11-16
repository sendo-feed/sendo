import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app";
import { PAGE_CONTENT_RETRY_MS } from "../../src/db/page-contents";
import { runJob } from "../../src/jobs";
import type { Job } from "../../src/jobs/job";
import type { Platform } from "../../src/platform";
import { createNodePlatform, withPublicOrigin } from "../../src/platform/node";
import { createSqliteJobQueue, type SqliteJobQueue } from "../../src/platform/node/job-queue";
import { createPageContentExtractor, loadNativeModule } from "../../src/platform/node/native";
import { createTokenForEmail, normalizeTokenRequest } from "../../src/platform/node/token";
import { articlePage, NATIVE_MODULE, openTestDatabase } from "./helpers";

const FEED_URL = "https://news.example.com/feed.xml";

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>Example News</title>
    <link>https://news.example.com/</link>
    <item>
      <title>Hello</title>
      <link>https://news.example.com/hello</link>
      <guid>hello</guid>
      <pubDate>Mon, 16 Nov 2026 00:00:00 GMT</pubDate>
      <description>short</description>
      <content:encoded><![CDATA[<p>full <b>body</b><script>alert(1)</script></p>]]></content:encoded>
    </item>
  </channel>
</rss>`;

const PAGE_URL = "https://news.example.com/hello";

/** 記事のページの応答。テストごとに差し替える */
let pageResponse: () => Response;
/** 記事のページを取りにいった回数 */
let pageFetches = 0;

/** 決まったフィードと記事のページだけを返す fetch。外への通信はしない */
const fakeFetch: typeof fetch = async (input) => {
  const url = String(input);
  if (url === FEED_URL) {
    return new Response(RSS, { headers: { "content-type": "application/rss+xml" } });
  }
  if (url === PAGE_URL) {
    pageFetches++;
    return pageResponse();
  }
  return new Response("not found", { status: 404 });
};

/** コンテナ版の組み立て（src/platform/node/main.ts と同じ）で、アプリを通して動かす */
describe("コンテナ版でアプリを動かす", () => {
  let database: Awaited<ReturnType<typeof openTestDatabase>>;
  let jobs: SqliteJobQueue;
  let platform: Platform;
  let token: string;

  const request = (pathname: string, init: RequestInit & { json?: unknown } = {}) => {
    const { json, ...rest } = init;
    const headers = new Headers(rest.headers);
    headers.set("authorization", `Bearer ${token}`);
    if (json !== undefined) headers.set("content-type", "application/json");
    return createApp(platform).request(pathname, {
      ...rest,
      headers,
      ...(json !== undefined && { body: JSON.stringify(json) }),
    });
  };

  /**
   * 積まれた仕事を、なくなるまで動かす。extract を false にすると、ページから抜く仕事は動かさずに捨てる
   * （仕事が動く前に開いた場合を試す）
   */
  const drain = async (options: { extract?: boolean } = {}) => {
    const run = async (job: Job) => {
      if (job.type === "extract-page" && options.extract === false) return;
      await runJob(platform, job);
    };
    while ((await jobs.runDue(run)) > 0) {}
  };

  beforeEach(async () => {
    database = await openTestDatabase();
    jobs = createSqliteJobQueue(database.db);
    pageFetches = 0;
    pageResponse = () =>
      new Response(articlePage({ script: true }), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    platform = createNodePlatform({
      env: { DATA_DIR: path.join(database.directory, "data") },
      db: database.db,
      jobs,
      fetch: fakeFetch,
      pageContent: createPageContentExtractor(loadNativeModule(NATIVE_MODULE)),
    });
    token = await createTokenForEmail(
      database.db,
      { email: " Me@Example.com ", name: "CLI", mcp: false, write: false },
      new Date(),
    );
  });

  afterEach(async () => {
    await database.cleanup();
  });

  it("発行したトークンで API を使える", async () => {
    const res = await request("/api/v1/me");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ user: { email: "me@example.com" } });
  });

  it("購読して取得の仕事を動かすと、記事と本文（ファイルの置き場）が読める", async () => {
    const subscribed = await request("/api/v1/feeds", { method: "POST", json: { url: FEED_URL } });
    expect(subscribed.status).toBeLessThan(300);
    await drain();

    const list = await request("/api/v1/articles");
    expect(list.status).toBe(200);
    const { items: articles } = (await list.json()) as { items: { id: string; title: string }[] };
    expect(articles.map((article) => article.title)).toEqual(["Hello"]);

    const content = await request(`/api/v1/articles/${articles[0]?.id}/content`);
    expect(content.status).toBe(200);
    const body = JSON.stringify(await content.json());
    expect(body).toContain("<b>body</b>");
    expect(body).not.toContain("<script>");
  });

  /** フィードを購読して取り込み、記事の ID を返す */
  const subscribeAndFetch = async (options: { extract?: boolean } = {}) => {
    await request("/api/v1/feeds", { method: "POST", json: { url: FEED_URL } });
    await drain(options);
    const { items } = (await (await request("/api/v1/articles")).json()) as {
      items: { id: string }[];
    };
    const id = items[0]?.id;
    if (id === undefined) throw new Error("no article");
    return id;
  };

  it("使える機能として、ページの本文を抜けることを返す", async () => {
    const res = await request("/api/v1/features");
    expect(await res.json()).toEqual({ pageContent: true });
  });

  it("取り込んだときに記事のページから本文を抜き、開いたときは取りにいかずに返す", async () => {
    const id = await subscribeAndFetch();
    // 取得の仕事のあとで、ページから抜く仕事が動いている
    expect(pageFetches).toBe(1);

    const first = await request(`/api/v1/articles/${id}/content?source=page`);
    expect(first.status).toBe(200);
    const body = (await first.json()) as { html: string; source: string };
    expect(body.source).toBe("page");
    expect(body.html).toContain("段落 0");
    expect(body.html).toContain("https://news.example.com/related/0");
    expect(body.html).not.toContain("<script");
    expect(body.html).not.toContain("onerror");
    expect(body.html).not.toContain("メニュー");

    const second = await request(`/api/v1/articles/${id}/content?source=page`);
    expect(await second.json()).toEqual(body);
    expect(pageFetches).toBe(1);

    // フィードの本文は、今までどおり返す
    const feed = await request(`/api/v1/articles/${id}/content`);
    expect(await feed.json()).toMatchObject({ source: "feed" });
  });

  it("抜く仕事が動く前に 2 人が同時に開いても、取りにいくのは 1 回", async () => {
    const id = await subscribeAndFetch({ extract: false });
    expect(pageFetches).toBe(0);
    const [a, b] = await Promise.all([
      request(`/api/v1/articles/${id}/content?source=page`),
      request(`/api/v1/articles/${id}/content?source=page`),
    ]);
    expect(a.status).toBe(200);
    expect(await b.json()).toEqual(await a.json());
    expect(pageFetches).toBe(1);
  });

  it.each([
    ["HTML でない", () => new Response("{}", { headers: { "content-type": "application/json" } })],
    ["取れない", () => new Response("gone", { status: 410 })],
    [
      "本文が見つからない",
      () =>
        new Response("<html><body></body></html>", { headers: { "content-type": "text/html" } }),
    ],
  ])("抜けなければ（%s）404 を返し、1 日は取りにいき直さない", async (_, response) => {
    pageResponse = response;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // 抜く仕事が抜けずに記録する
    const id = await subscribeAndFetch();
    expect(pageFetches).toBe(1);

    const first = await request(`/api/v1/articles/${id}/content?source=page`);
    expect(first.status).toBe(404);
    expect(await first.json()).toMatchObject({ error: { code: "page_content_unavailable" } });
    await request(`/api/v1/articles/${id}/content?source=page`);
    expect(pageFetches).toBe(1);

    // 1 日たてば、取りにいき直す
    const later = new Date(Date.now() + PAGE_CONTENT_RETRY_MS + 1000);
    platform = { ...platform, now: () => later };
    await request(`/api/v1/articles/${id}/content?source=page`);
    expect(pageFetches).toBe(2);
    vi.restoreAllMocks();
  });

  it("受信箱にない記事は、ページを取りにいかずに 404 を返す", async () => {
    const res = await request("/api/v1/articles/missing/content?source=page");
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: "not_found" } });
    expect(pageFetches).toBe(0);
  });

  it("差分同期で、フォルダの変更を受け取れる", async () => {
    await request("/api/v1/folders", { method: "POST", json: { name: "tech" } });
    const res = await request("/api/v1/sync");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ folders: [{ name: "tech", deleted: false }] });
  });
});

describe("トークンの発行の入力", () => {
  it("形の正しくない入力は受けない", () => {
    const base = { email: "me@example.com", name: "CLI", mcp: false, write: false };
    expect(() => normalizeTokenRequest({ ...base, email: "not-an-email" })).toThrow();
    expect(() => normalizeTokenRequest({ ...base, name: " " })).toThrow();
    expect(() => normalizeTokenRequest({ ...base, write: true })).toThrow();
    expect(normalizeTokenRequest({ ...base, mcp: true, write: true })).toMatchObject({
      mcp: true,
      write: true,
    });
  });
});

describe("withPublicOrigin", () => {
  const echo = async (request: Request) =>
    Response.json({ url: request.url, method: request.method, body: await request.text() });

  it("リクエストの URL のオリジンを、PUBLIC_URL のオリジンに置き換える。本文はそのまま渡す", async () => {
    const handler = withPublicOrigin(echo, "https://sendo.example.com");
    const res = await handler(
      new Request("http://0.0.0.0:8787/api/v1/folders?x=1", { method: "POST", body: "hello" }),
    );
    expect(await res.json()).toEqual({
      url: "https://sendo.example.com/api/v1/folders?x=1",
      method: "POST",
      body: "hello",
    });
  });

  it("パスでホストを変えられない（//host/... のようなパスも、パスのまま扱う）", async () => {
    const handler = withPublicOrigin(echo, "https://sendo.example.com");
    const res = await handler(
      new Request("http://0.0.0.0:8787//evil.example.com/api/v1/auth/logout", { method: "POST" }),
    );
    const { url } = (await res.json()) as { url: string };
    expect(new URL(url).origin).toBe("https://sendo.example.com");
    expect(new URL(url).pathname).toBe("//evil.example.com/api/v1/auth/logout");
  });

  it("PUBLIC_URL がなければ、そのまま渡す", async () => {
    const handler = withPublicOrigin(echo, undefined);
    const res = await handler(new Request("http://localhost:8787/healthz"));
    expect(await res.json()).toMatchObject({ url: "http://localhost:8787/healthz" });
  });
});
