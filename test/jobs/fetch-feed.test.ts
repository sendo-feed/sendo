import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { insertArticles } from "../../src/db/articles";
import { getFeed, insertFeed } from "../../src/db/feeds";
import { deliverNewArticles, setArticleState } from "../../src/db/inbox";
import { CLEAN_UP_CATCH_UP } from "../../src/db/retention";
import { articles, feeds, userArticles } from "../../src/db/schema";
import { MAX_ITEMS } from "../../src/fetcher/parse-feed";
import { runFetchFeed } from "../../src/jobs/fetch-feed";
import { createTestPlatform, fakeFetch, subscribeFeed, TEST_USER, uniqueUrl } from "../helpers";

const NOW = new Date("2026-11-14T00:00:00Z");
/** 設定した取得の間隔。既定（30 分）と違う値にして、設定が使われることを確かめる */
const INTERVAL_MS = 45 * 60 * 1000;

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
  const { platform } = createTestPlatform({
    fetch: fake.fetch,
    now: () => NOW,
    fetchConfig: { intervalMs: INTERVAL_MS },
  });
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
      nextFetchAt: new Date(NOW.getTime() + INTERVAL_MS),
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
    expect(once?.nextFetchAt).toEqual(new Date(NOW.getTime() + INTERVAL_MS * 2));

    await runFetchFeed(platform, feed.id);
    const twice = await getFeed(platform.db, feed.id);
    expect(twice?.errorCount).toBe(2);
    expect(twice?.nextFetchAt).toEqual(new Date(NOW.getTime() + INTERVAL_MS * 4));
  });

  it("失敗したときに延ばす間隔は、1 日より長い設定の間隔より短くしない", async () => {
    const twoDays = 2 * 24 * 60 * 60 * 1000;
    const { platform, feed } = await setup(() => new Response("oops", { status: 500 }));

    await runFetchFeed({ ...platform, fetchConfig: { intervalMs: twoDays } }, feed.id);

    expect((await getFeed(platform.db, feed.id))?.nextFetchAt).toEqual(
      new Date(NOW.getTime() + twoDays),
    );
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

describe("runFetchFeed の古い記事の片付け（docs/decisions/retention.md）", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY);

  /**
   * 購読したフィードに、95 日前に取り込んだ記事を 2 つ入れる。listed は RSS に載っている記事
   * （guid が "1"）、gone はもう載っていない記事。片付けの位置は、その少し前まで進んでいる
   */
  async function setupOld(respond: Parameters<typeof fakeFetch>[0]) {
    const fake = fakeFetch(respond);
    const { platform } = createTestPlatform({
      fetch: fake.fetch,
      now: () => NOW,
      fetchConfig: { intervalMs: INTERVAL_MS },
    });
    const feed = await subscribeFeed(platform, { now: daysAgo(200) });
    await insertArticles(
      platform.db,
      ["1", "gone"].map((guid) => ({
        id: `${feed.id}-${guid}`,
        feedId: feed.id,
        guid,
        url: null,
        title: guid,
        summary: null,
        author: null,
        publishedAt: daysAgo(95),
        createdAt: daysAgo(95),
      })),
    );
    await deliverNewArticles(platform.db, { feedId: feed.id });
    await platform.db
      .update(feeds)
      .set({ cleanedUntil: new Date(daysAgo(95).getTime() - 60_000) })
      .where(eq(feeds.id, feed.id))
      .run();
    const inbox = async () =>
      (
        await platform.db
          .select({ guid: articles.guid })
          .from(userArticles)
          .innerJoin(articles, eq(articles.id, userArticles.articleId))
          .where(and(eq(userArticles.userId, TEST_USER.id), eq(userArticles.feedId, feed.id)))
          .all()
      )
        .map((row) => row.guid)
        .sort();
    const guids = async () =>
      (
        await platform.db
          .select({ guid: articles.guid })
          .from(articles)
          .where(eq(articles.feedId, feed.id))
          .all()
      )
        .map((row) => row.guid)
        .sort();
    return { platform, feed, inbox, guids };
  }

  it("期間を過ぎた記事を受信箱から消し、フィードに載っていない記事の行を消す", async () => {
    const { platform, feed, inbox, guids } = await setupOld(() => new Response(RSS));
    expect(await inbox()).toEqual(["1", "gone"]);

    await runFetchFeed(platform, feed.id);

    // 今回取り込んだ 2 件だけが受信箱に残る
    expect(await inbox()).toEqual(["https://blog.example/2", expect.stringMatching(/^sha256:/)]);
    // RSS に載っている "1" は、行を残す
    expect(await guids()).toEqual([
      "1",
      "https://blog.example/2",
      expect.stringMatching(/^sha256:/),
    ]);
    // 片付けた位置を記録する。進める幅は、取得の間隔の CLEAN_UP_CATCH_UP 倍まで
    expect((await getFeed(platform.db, feed.id))?.cleanedUntil).toEqual(
      new Date(daysAgo(95).getTime() - 60_000 + CLEAN_UP_CATCH_UP * INTERVAL_MS),
    );
  });

  it("行を残した記事は、次の取得で入り直さない", async () => {
    const { platform, feed, inbox } = await setupOld(() => new Response(RSS));
    await runFetchFeed(platform, feed.id);

    expect(await runFetchFeed(platform, feed.id)).toEqual({ status: "fetched", inserted: 0 });
    expect(await inbox()).not.toContain("1");
  });

  it("304 でも、取得に失敗しても、受信箱は片付ける", async () => {
    for (const response of [
      () => new Response(null, { status: 304 }),
      () => new Response("oops", { status: 500 }),
    ]) {
      const { platform, feed, inbox, guids } = await setupOld(response);

      await runFetchFeed(platform, feed.id);

      expect(await inbox()).toEqual([]);
      // フィードに載っているかが分からないので、記事の行は消さない
      expect(await guids()).toEqual(["1", "gone"]);
      expect((await getFeed(platform.db, feed.id))?.cleanedUntil?.getTime()).toBeGreaterThan(
        daysAgo(95).getTime(),
      );
    }
  });

  it("解析の上限まで記事が載っているフィードでは、記事の行を消さない", async () => {
    // 上限より後ろに、まだ載っているかもしれないため
    const items = Array.from(
      { length: MAX_ITEMS },
      (_, i) => `<item><title>t${i}</title><link>https://blog.example/${i}</link></item>`,
    ).join("");
    const { platform, feed, inbox, guids } = await setupOld(
      () => new Response(`<rss version="2.0"><channel><title>b</title>${items}</channel></rss>`),
    );

    await runFetchFeed(platform, feed.id);

    expect(await inbox()).not.toContain("gone");
    expect(await guids()).toContain("gone");
  });

  it("スターを付けた記事は、受信箱にも記事の表にも残す", async () => {
    const { platform, feed, inbox, guids } = await setupOld(() => new Response(RSS));
    await setArticleState(platform.db, {
      userId: TEST_USER.id,
      articleId: `${feed.id}-gone`,
      starred: true,
      now: NOW,
    });

    await runFetchFeed(platform, feed.id);

    expect(await inbox()).toContain("gone");
    expect(await guids()).toContain("gone");
  });
});
