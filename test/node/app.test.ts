import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import { runJob } from "../../src/jobs";
import type { Platform } from "../../src/platform";
import { createNodePlatform, withPublicOrigin } from "../../src/platform/node";
import { createSqliteJobQueue, type SqliteJobQueue } from "../../src/platform/node/job-queue";
import { createTokenForEmail, normalizeTokenRequest } from "../../src/platform/node/token";
import { openTestDatabase } from "./helpers";

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

/** 決まったフィードだけを返す fetch。外への通信はしない */
const fakeFetch: typeof fetch = async (input) => {
  const url = String(input);
  if (url === FEED_URL) {
    return new Response(RSS, { headers: { "content-type": "application/rss+xml" } });
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

  /** 積まれた仕事を、なくなるまで動かす */
  const drain = async () => {
    while ((await jobs.runDue((job) => runJob(platform, job))) > 0) {}
  };

  beforeEach(async () => {
    database = await openTestDatabase();
    jobs = createSqliteJobQueue(database.db);
    platform = createNodePlatform({
      env: { DATA_DIR: path.join(database.directory, "data") },
      db: database.db,
      jobs,
      fetch: fakeFetch,
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
