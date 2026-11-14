import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getFeed, insertFeed } from "../../src/db/feeds";
import { articles } from "../../src/db/schema";
import { FETCH_INTERVAL_MS, runFetchFeed } from "../../src/jobs/fetch-feed";
import { createTestPlatform, fakeFetch, uniqueUrl } from "../helpers";

const NOW = new Date("2026-11-14T00:00:00Z");

const RSS = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>Blog</title><link>https://blog.example/</link>
  <item><title>One</title><link>https://blog.example/1</link><guid>1</guid>
    <pubDate>Thu, 13 Nov 2026 00:00:00 GMT</pubDate></item>
  <item><title>Two</title><link>https://blog.example/2</link></item>
  <item><title>No id or link</title><description>body</description></item>
</channel></rss>`;

async function setup(respond: Parameters<typeof fakeFetch>[0]) {
  const fake = fakeFetch(respond);
  const { platform } = createTestPlatform({ fetch: fake.fetch, now: () => NOW });
  const { feed } = await insertFeed(platform.db, {
    id: crypto.randomUUID(),
    url: uniqueUrl(),
    now: NOW,
  });
  const articlesOf = () =>
    platform.db.select().from(articles).where(eq(articles.feedId, feed.id)).all();
  return { platform, feed, calls: fake.calls, articlesOf };
}

describe("runFetchFeed", () => {
  it("記事を取り込み、フィードの情報と次の取得の時刻を記録する", async () => {
    const { platform, feed, articlesOf } = await setup(
      () => new Response(RSS, { headers: { etag: '"e1"' } }),
    );

    expect(await runFetchFeed(platform, feed.id)).toEqual({ status: "fetched", inserted: 3 });

    const saved = await getFeed(platform.db, feed.id);
    expect(saved).toMatchObject({
      title: "Blog",
      siteUrl: "https://blog.example/",
      etag: '"e1"',
      lastFetchedAt: NOW,
      nextFetchAt: new Date(NOW.getTime() + FETCH_INTERVAL_MS),
      errorCount: 0,
      lastError: null,
    });

    const rows = await articlesOf();
    expect(rows.map((row) => row.guid).sort()).toEqual([
      "1",
      "https://blog.example/2",
      expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    ]);
    // 日付のない記事は、取り込んだ時刻になる
    expect(rows.find((row) => row.guid === "https://blog.example/2")?.publishedAt).toEqual(NOW);
  });

  it("記事の取り込み時刻は、取得を始めた時刻ではなく、DB に入れた時刻になる", async () => {
    const { platform, feed, articlesOf } = await setup(() => new Response(RSS));

    await runFetchFeed(platform, feed.id);

    // platform.now() は NOW（過去）を返すが、取り込み時刻は DB の時計（今）で決まる
    for (const row of await articlesOf()) {
      expect(row.createdAt.getTime()).toBeGreaterThan(NOW.getTime());
    }
  });

  it("もう一度取得しても、記事は重複しない", async () => {
    const { platform, feed, articlesOf } = await setup(() => new Response(RSS));

    await runFetchFeed(platform, feed.id);
    expect(await runFetchFeed(platform, feed.id)).toEqual({ status: "fetched", inserted: 0 });
    expect(await articlesOf()).toHaveLength(3);
  });

  it("前回の ETag を送り、304 なら記事に触れない", async () => {
    let first = true;
    const { platform, feed, calls, articlesOf } = await setup(() => {
      if (first) {
        first = false;
        return new Response(RSS, { headers: { etag: '"e1"' } });
      }
      return new Response(null, { status: 304 });
    });

    await runFetchFeed(platform, feed.id);
    expect(await runFetchFeed(platform, feed.id)).toEqual({ status: "not-modified" });
    expect(calls[1]?.headers.get("if-none-match")).toBe('"e1"');
    expect(await articlesOf()).toHaveLength(3);
    expect((await getFeed(platform.db, feed.id))?.etag).toBe('"e1"');
  });

  it("取得に失敗したら記録し、続けて失敗するほど間隔を延ばす", async () => {
    const { platform, feed } = await setup(() => new Response("oops", { status: 500 }));

    const first = await runFetchFeed(platform, feed.id);
    expect(first).toMatchObject({ status: "failed" });
    const once = await getFeed(platform.db, feed.id);
    expect(once).toMatchObject({ errorCount: 1, lastError: expect.stringContaining("500") });
    expect(once?.nextFetchAt).toEqual(new Date(NOW.getTime() + FETCH_INTERVAL_MS * 2));

    await runFetchFeed(platform, feed.id);
    const twice = await getFeed(platform.db, feed.id);
    expect(twice?.errorCount).toBe(2);
    expect(twice?.nextFetchAt).toEqual(new Date(NOW.getTime() + FETCH_INTERVAL_MS * 4));
  });

  it("フィードとして読めなければ、失敗として記録する", async () => {
    const { platform, feed } = await setup(() => new Response("<html>not a feed</html>"));

    expect(await runFetchFeed(platform, feed.id)).toMatchObject({ status: "failed" });
    expect((await getFeed(platform.db, feed.id))?.lastError).toMatch(/^ParseFeedError/);
  });

  it("成功したら、失敗の回数を戻す", async () => {
    let fail = true;
    const { platform, feed } = await setup(() =>
      fail ? new Response("x", { status: 503 }) : new Response(RSS),
    );

    await runFetchFeed(platform, feed.id);
    fail = false;
    await runFetchFeed(platform, feed.id);

    expect(await getFeed(platform.db, feed.id)).toMatchObject({ errorCount: 0, lastError: null });
  });

  it("消されたフィードなら何もしない", async () => {
    const { platform } = createTestPlatform();
    expect(await runFetchFeed(platform, crypto.randomUUID())).toEqual({ status: "missing" });
  });
});
