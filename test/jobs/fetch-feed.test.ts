import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { insertArticles } from "../../src/db/articles";
import { getFeed, insertFeed } from "../../src/db/feeds";
import { articles, feeds } from "../../src/db/schema";
import { ICON_CHECK_INTERVAL_MS, runFetchFeed } from "../../src/jobs/fetch-feed";
import {
  FETCH_FAILURE_WINDOW_MS,
  MAX_FETCH_INTERVAL_MS,
  STALLED_FETCH_INTERVAL_MS,
} from "../../src/jobs/fetch-interval";
import type { Platform } from "../../src/platform";
import { PNG } from "../fixtures/images";
import { createTestPlatform, fakeFetch, uniqueUrl } from "../helpers";

const NOW = new Date("2026-11-14T00:00:00Z");
/** 設定した取得の間隔。既定（30 分）と違う値にして、設定が使われることを確かめる */
const INTERVAL_MS = 45 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

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

describe("サムネイルとアイコン（docs/decisions/images.md）", () => {
  const SITE_RSS = (extra = "") => `<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/">
    <channel><title>Blog</title><link>https://blog.example/</link>
    <item><title>One</title><guid>1</guid><media:thumbnail url="https://blog.example/t.jpg"/></item>
    <item><title>Two</title><guid>2</guid></item>${extra}</channel></rss>`;

  /** フィード、サイトのページ、画像に、それらしい応答を返す */
  const site = (options: { icon?: boolean; feedStatus?: number } = {}) =>
    setup((url) => {
      if (url.hostname !== "blog.example") {
        return options.feedStatus === 304
          ? new Response(null, { status: 304 })
          : new Response(SITE_RSS(), { headers: { etag: '"e1"' } });
      }
      if (url.pathname === "/") return new Response('<link rel="icon" href="/icon.png">');
      if (url.pathname === "/icon.png" && options.icon !== false) return new Response(PNG);
      return new Response(null, { status: 404 });
    });

  it("記事のサムネイルを、フィードの中から採って保存する", async () => {
    const { platform, feed, articlesOf } = await site();
    await runFetchFeed(platform, feed.id);
    const saved = await articlesOf();
    expect(saved.find((a) => a.guid === "1")?.thumbnailUrl).toBe("https://blog.example/t.jpg");
    expect(saved.find((a) => a.guid === "2")?.thumbnailUrl).toBeNull();
  });

  it("取り込んだ記事のサムネイルは、あとの取得で変えない", async () => {
    let thumbnail = "https://blog.example/t.jpg";
    const { platform, feed, articlesOf } = await setup((url) =>
      url.hostname === "blog.example"
        ? new Response(null, { status: 404 })
        : new Response(SITE_RSS().replace("https://blog.example/t.jpg", thumbnail)),
    );
    await runFetchFeed(platform, feed.id);
    thumbnail = "https://blog.example/changed.jpg";
    await runFetchFeed(platform, feed.id);
    expect((await articlesOf()).find((a) => a.guid === "1")?.thumbnailUrl).toBe(
      "https://blog.example/t.jpg",
    );
  });

  it("アイコンを探して、画像と確かめられたものを記録する", async () => {
    const { platform, feed } = await site();
    await runFetchFeed(platform, feed.id);
    expect(await getFeed(platform.db, feed.id)).toMatchObject({
      iconUrl: "https://blog.example/icon.png",
      iconCheckedAt: NOW,
    });
  });

  it("アイコンが見つからなくても、取得は成功し、探した時刻を記録する", async () => {
    const { platform, feed } = await site({ icon: false });
    expect(await runFetchFeed(platform, feed.id)).toMatchObject({ status: "fetched" });
    expect(await getFeed(platform.db, feed.id)).toMatchObject({
      iconUrl: null,
      iconCheckedAt: NOW,
      errorCount: 0,
    });
  });

  it("探してから 30 日たつまでは、探し直さない", async () => {
    const { platform, feed, calls } = await site();
    await runFetchFeed(platform, feed.id);
    const before = calls.length;

    await runFetchFeed(
      { ...platform, now: () => new Date(NOW.getTime() + ICON_CHECK_INTERVAL_MS - 1) },
      feed.id,
    );
    expect(calls.length - before).toBe(1); // フィードの取得だけ

    await runFetchFeed(
      { ...platform, now: () => new Date(NOW.getTime() + ICON_CHECK_INTERVAL_MS) },
      feed.id,
    );
    expect(calls.length - before).toBeGreaterThan(2);
  });

  it("304 のときも、サイトの URL が分かっていれば探す", async () => {
    const { platform, feed } = await site({ feedStatus: 304 });
    await platform.db
      .update(feeds)
      .set({ siteUrl: "https://blog.example/" })
      .where(eq(feeds.id, feed.id));
    expect(await runFetchFeed(platform, feed.id)).toEqual({ status: "not-modified" });
    expect((await getFeed(platform.db, feed.id))?.iconUrl).toBe("https://blog.example/icon.png");
  });

  it("フィードの取得に失敗したときは、探さない", async () => {
    const { platform, feed } = await setup(() => new Response("oops", { status: 500 }));
    await runFetchFeed(platform, feed.id);
    expect((await getFeed(platform.db, feed.id))?.iconCheckedAt).toBeNull();
  });
});

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
      lastSuccessfulFetchAt: NOW,
      // 記事は 1 日前に 1 件、今（日付のない 2 件）。1 日 ÷ 3 件 ＝ 8 時間の 3 分の 1
      // （docs/decisions/jobs.md の 7）
      nextFetchAt: new Date(NOW.getTime() + (8 * HOUR) / 3),
      fetchIntervalMs: (8 * HOUR) / 3,
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
    // 公開時刻が分かるのは、フィードに時刻まで書いてあった記事だけ（docs/decisions/jobs.md の 11）
    expect(Object.fromEntries(rows.map((row) => [row.guid, row.publishedTimeKnown]))).toMatchObject(
      { "1": true, "https://blog.example/2": false },
    );
    expect(rows.filter((row) => row.publishedTimeKnown)).toHaveLength(1);
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
    // フィードの取得のほかに、アイコンを探す取得も入る
    const fetches = calls.filter((call) => call.url === feed.url);
    expect(fetches[1]?.headers.get("if-none-match")).toBe('"e1"');
    expect(await articlesOf()).toHaveLength(3);
    expect((await getFeed(platform.db, feed.id))?.etag).toBe('"e1"');
  });

  it("取得に失敗したら記録し、続けて失敗するほど間隔を延ばす", async () => {
    const { platform, feed } = await setup(() => new Response("oops", { status: 500 }));

    const first = await runFetchFeed(platform, feed.id);
    expect(first).toMatchObject({ status: "failed" });
    const once = await getFeed(platform.db, feed.id);
    expect(once).toMatchObject({
      errorCount: 1,
      lastError: expect.stringContaining("500"),
      lastSuccessfulFetchAt: null,
    });
    expect(once?.nextFetchAt).toEqual(new Date(NOW.getTime() + INTERVAL_MS * 2));

    const next = new Date(NOW.getTime() + 2 * INTERVAL_MS);
    await runFetchFeed({ ...platform, now: () => next }, feed.id);
    const twice = await getFeed(platform.db, feed.id);
    expect(twice?.errorCount).toBe(2);
    expect(twice?.nextFetchAt).toEqual(new Date(next.getTime() + INTERVAL_MS * 4));
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

  it("200 の HTML から移転先候補を探し、リンクが消えたら候補を消す", async () => {
    let fallback = '<link rel="alternate" type="application/rss+xml" href="/new.xml">';
    const { platform, feed, articlesOf } = await setup((url) =>
      url.pathname === "/new.xml" ? new Response(RSS) : new Response(`<html>${fallback}</html>`),
    );

    expect(await runFetchFeed(platform, feed.id)).toMatchObject({ status: "failed" });
    expect(await getFeed(platform.db, feed.id)).toMatchObject({
      lastErrorCode: "invalid_feed",
      relocationCandidate: { url: new URL("/new.xml", feed.url).href, title: "Blog" },
    });
    expect(await articlesOf()).toEqual([]);

    fallback = "temporary page";
    await runFetchFeed(
      { ...platform, now: () => new Date(NOW.getTime() + 2 * INTERVAL_MS) },
      feed.id,
    );
    expect(await getFeed(platform.db, feed.id)).toMatchObject({ relocationCandidate: null });
  });

  it("成功したら、失敗の回数を戻す", async () => {
    let fail = true;
    const { platform, feed } = await setup(() =>
      fail ? new Response("x", { status: 503 }) : new Response(RSS),
    );

    await runFetchFeed(platform, feed.id);
    fail = false;
    await runFetchFeed({ ...platform, now: () => new Date(NOW.getTime() + HOUR) }, feed.id);

    expect(await getFeed(platform.db, feed.id)).toMatchObject({
      errorCount: 0,
      lastError: null,
      lastErrorCode: null,
      failureStartedAt: null,
      fetchStalled: false,
    });
  });

  it("失敗を記録してから 30 日で週 1 回にし、304 で通常に戻す", async () => {
    // 0 は、名前解決に失敗したことにする
    let status = 0;
    const { platform, feed } = await setup(() => {
      if (status === 0) {
        throw new TypeError("fetch failed", {
          cause: Object.assign(new Error(), { code: "ENOTFOUND" }),
        });
      }
      return new Response(null, { status });
    });
    // 導入前から失敗していても、失敗が始まった時刻は分からない
    await platform.db
      .update(feeds)
      .set({ errorCount: 15, lastFetchedAt: new Date(NOW.getTime() - FETCH_FAILURE_WINDOW_MS) })
      .where(eq(feeds.id, feed.id));

    const attempt = async (elapsedMs: number) => {
      const now = new Date(NOW.getTime() + elapsedMs);
      await runFetchFeed({ ...platform, now: () => now }, feed.id);
      return getFeed(platform.db, feed.id);
    };
    expect(await attempt(0)).toMatchObject({
      failureStartedAt: NOW,
      fetchStalled: false,
      lastErrorCode: "dns",
    });
    expect(await attempt(FETCH_FAILURE_WINDOW_MS - 1)).toMatchObject({
      failureStartedAt: NOW,
      fetchStalled: false,
    });
    status = 429;
    expect(await attempt(FETCH_FAILURE_WINDOW_MS)).toMatchObject({
      failureStartedAt: NOW,
      fetchStalled: false,
      errorCount: 17,
      lastErrorCode: "rate_limited",
    });
    status = 0;
    const stalledAfter = FETCH_FAILURE_WINDOW_MS + MAX_FETCH_INTERVAL_MS;
    expect(await attempt(stalledAfter)).toMatchObject({
      fetchStalled: true,
      nextFetchAt: new Date(NOW.getTime() + stalledAfter + STALLED_FETCH_INTERVAL_MS),
    });
    status = 304;
    expect(await attempt(stalledAfter + STALLED_FETCH_INTERVAL_MS)).toMatchObject({
      errorCount: 0,
      lastError: null,
      lastErrorCode: null,
      failureStartedAt: null,
      fetchStalled: false,
      nextFetchAt: new Date(
        NOW.getTime() + stalledAfter + STALLED_FETCH_INTERVAL_MS + MAX_FETCH_INTERVAL_MS,
      ),
    });
  });

  it("410 ですぐ週 1 回にし、429 を受けても取得間隔を縮めない", async () => {
    let status = 410;
    const { platform, feed } = await setup(() => new Response(null, { status }));
    await runFetchFeed(platform, feed.id);
    const next = new Date(NOW.getTime() + STALLED_FETCH_INTERVAL_MS);
    expect(await getFeed(platform.db, feed.id)).toMatchObject({
      fetchStalled: true,
      nextFetchAt: next,
      errorCount: 1,
      lastErrorCode: "gone",
    });
    status = 429;
    await runFetchFeed({ ...platform, now: () => next }, feed.id);
    expect(await getFeed(platform.db, feed.id)).toMatchObject({
      fetchStalled: true,
      nextFetchAt: new Date(next.getTime() + STALLED_FETCH_INTERVAL_MS),
      errorCount: 1,
      lastErrorCode: "rate_limited",
    });
  });

  it("後から完了した古い取得の 410 で、成功済みの状態を上書きしない", async () => {
    const pending = Promise.withResolvers<Response>();
    const started = Promise.withResolvers<void>();
    const { platform, feed } = await setup(() => {
      started.resolve();
      return pending.promise;
    });
    const slow = runFetchFeed(platform, feed.id);
    await started.promise;

    try {
      const newer = new Date(NOW.getTime() + 1);
      await runFetchFeed(
        {
          ...platform,
          now: () => newer,
          fetch: fakeFetch(() => new Response(null, { status: 304 })).fetch,
        },
        feed.id,
      );
    } finally {
      pending.resolve(new Response(null, { status: 410 }));
      await slow;
    }

    expect(await getFeed(platform.db, feed.id)).toMatchObject({
      fetchStalled: false,
      errorCount: 0,
      lastSuccessfulFetchAt: new Date(NOW.getTime() + 1),
      nextFetchAt: new Date(NOW.getTime() + 1 + MAX_FETCH_INTERVAL_MS),
    });
  });

  it("後から完了した古い成功の時刻を、最新の失敗とともに残す", async () => {
    const pending = Promise.withResolvers<Response>();
    const started = Promise.withResolvers<void>();
    const { platform, feed } = await setup(() => {
      started.resolve();
      return pending.promise;
    });
    const slow = runFetchFeed(platform, feed.id);
    await started.promise;

    const failedAt = new Date(NOW.getTime() + 1);
    try {
      await runFetchFeed(
        {
          ...platform,
          now: () => failedAt,
          fetch: fakeFetch(() => new Response(null, { status: 410 })).fetch,
        },
        feed.id,
      );
    } finally {
      pending.resolve(new Response(RSS));
      await slow;
    }

    expect(await getFeed(platform.db, feed.id)).toMatchObject({
      title: null,
      fetchStalled: true,
      lastErrorCode: "gone",
      lastFetchedAt: failedAt,
      lastSuccessfulFetchAt: NOW,
    });
  });

  it.each([
    { status: 429, errorCount: 1, lastErrorCode: "rate_limited", wait: 3 * HOUR },
    { status: 304, errorCount: 0, lastErrorCode: null, wait: MAX_FETCH_INTERVAL_MS },
  ])(
    "先に開始した失敗が先に記録されても、後続の $status の結果を記録する",
    async ({ status, errorCount, lastErrorCode, wait }) => {
      const olderResponse = Promise.withResolvers<Response>();
      const olderStarted = Promise.withResolvers<void>();
      const { platform, feed } = await setup(() => {
        olderStarted.resolve();
        return olderResponse.promise;
      });
      const older = runFetchFeed(platform, feed.id);
      await olderStarted.promise;

      const newerResponse = Promise.withResolvers<Response>();
      const newerStarted = Promise.withResolvers<void>();
      const newerAt = new Date(NOW.getTime() + 1);
      const newer = runFetchFeed(
        {
          ...platform,
          now: () => newerAt,
          fetch: fakeFetch(() => {
            newerStarted.resolve();
            return newerResponse.promise;
          }).fetch,
        },
        feed.id,
      );
      await newerStarted.promise;

      try {
        olderResponse.resolve(new Response(null, { status: 500 }));
        await older;
      } finally {
        const headers = new Headers();
        if (status === 429) headers.set("retry-after", "10800");
        newerResponse.resolve(new Response(null, { status, headers }));
        await newer;
      }

      expect(await getFeed(platform.db, feed.id)).toMatchObject({
        lastFetchedAt: newerAt,
        errorCount,
        lastErrorCode,
        nextFetchAt: new Date(newerAt.getTime() + wait),
      });
    },
  );

  it("消されたフィードなら何もしない", async () => {
    const { platform } = createTestPlatform();
    expect(await runFetchFeed(platform, crypto.randomUUID())).toEqual({ status: "missing" });
  });
});

/** 公開日時を決めた記事を並べた RSS */
function rssWithDates(dates: readonly Date[]): string {
  const items = dates
    .map(
      (date, i) =>
        `<item><title>${i}</title><link>https://blog.example/${i}</link><pubDate>${date.toUTCString()}</pubDate></item>`,
    )
    .join("");
  return `<rss version="2.0"><channel><title>b</title>${items}</channel></rss>`;
}

const setFetchInterval = (platform: Platform, feedId: string, ms: number) =>
  platform.db.update(feeds).set({ fetchIntervalMs: ms }).where(eq(feeds.id, feedId)).run();

describe("runFetchFeed の取得の間隔（docs/decisions/jobs.md の 7）", () => {
  const ago = (ms: number) => new Date(NOW.getTime() - ms);

  it("記事の出るペースから間隔を決め、フィードの行に記録する", async () => {
    // 6 時間おきに 4 件：24 時間 ÷ 4 件 ＝ 6 時間の 3 分の 1
    const { platform, feed } = await setup(
      () => new Response(rssWithDates([6, 12, 18, 24].map((h) => ago(h * HOUR)))),
    );

    await runFetchFeed(platform, feed.id);

    expect(await getFeed(platform.db, feed.id)).toMatchObject({
      fetchIntervalMs: 2 * HOUR,
      nextFetchAt: new Date(NOW.getTime() + 2 * HOUR),
    });
  });

  it("直近 7 日に記事がなければ、1 日おきにする", async () => {
    const { platform, feed } = await setup(
      () => new Response(rssWithDates([ago(30 * 24 * HOUR), ago(60 * 24 * HOUR)])),
    );

    await runFetchFeed(platform, feed.id);

    expect((await getFeed(platform.db, feed.id))?.nextFetchAt).toEqual(
      new Date(NOW.getTime() + MAX_FETCH_INTERVAL_MS),
    );
  });

  it("記事が多くても、設定の間隔より短くしない", async () => {
    const minutes = Array.from({ length: 40 }, (_, i) => ago(i * 60 * 1000));
    const { platform, feed } = await setup(() => new Response(rssWithDates(minutes)));

    await runFetchFeed(platform, feed.id);

    expect((await getFeed(platform.db, feed.id))?.fetchIntervalMs).toBe(INTERVAL_MS);
  });

  it("304 のときも、記事が出ないまま時間がたった分だけ間隔を延ばす", async () => {
    let now = NOW;
    let first = true;
    const fake = fakeFetch(() => {
      if (!first) return new Response(null, { status: 304 });
      first = false;
      return new Response(rssWithDates([ago(3 * HOUR), ago(6 * HOUR)]), {
        headers: { etag: '"e1"' },
      });
    });
    const { platform } = createTestPlatform({
      fetch: fake.fetch,
      now: () => now,
      fetchConfig: { intervalMs: INTERVAL_MS },
    });
    const { feed } = await insertFeed(platform.db, {
      id: crypto.randomUUID(),
      url: uniqueUrl(),
      now,
    });

    await runFetchFeed(platform, feed.id);
    // 6 時間 ÷ 2 件の 3 分の 1
    expect((await getFeed(platform.db, feed.id))?.fetchIntervalMs).toBe(HOUR);

    // 18 時間後：24 時間 ÷ 2 件の 3 分の 1
    now = new Date(NOW.getTime() + 18 * HOUR);
    expect(await runFetchFeed(platform, feed.id)).toEqual({ status: "not-modified" });
    expect(await getFeed(platform.db, feed.id)).toMatchObject({
      fetchIntervalMs: 4 * HOUR,
      nextFetchAt: new Date(now.getTime() + 4 * HOUR),
    });
  });

  it("失敗したときは、フィードの今の間隔をもとに延ばす", async () => {
    const { platform, feed } = await setup(() => new Response("oops", { status: 500 }));
    await setFetchInterval(platform, feed.id, 3 * HOUR);

    await runFetchFeed(platform, feed.id);

    expect(await getFeed(platform.db, feed.id)).toMatchObject({
      errorCount: 1,
      nextFetchAt: new Date(NOW.getTime() + 6 * HOUR),
      // 失敗では、決めた間隔を変えない
      fetchIntervalMs: 3 * HOUR,
    });
  });
});

describe("runFetchFeed の Retry-After（docs/decisions/jobs.md の 8）", () => {
  const nextFetchAtOf = async (response: () => Response, expectedErrorCount = 1) => {
    const { platform, feed } = await setup(response);
    expect(await runFetchFeed(platform, feed.id)).toMatchObject({ status: "failed" });
    const saved = await getFeed(platform.db, feed.id);
    expect(saved?.errorCount).toBe(expectedErrorCount);
    return saved?.nextFetchAt;
  };

  it("429 の Retry-After より前に、次の取得をしない", async () => {
    // 延ばす間隔（45 分 × 2）より長い 2 時間を待つ
    expect(
      await nextFetchAtOf(
        () => new Response("", { status: 429, headers: { "retry-after": "7200" } }),
        0,
      ),
    ).toEqual(new Date(NOW.getTime() + 2 * HOUR));
  });

  it("503 の Retry-After の日付を守る", async () => {
    const response = () =>
      new Response("", {
        status: 503,
        headers: {
          date: NOW.toUTCString(),
          "retry-after": new Date(NOW.getTime() + 5 * HOUR).toUTCString(),
        },
      });
    expect(await nextFetchAtOf(response)).toEqual(new Date(NOW.getTime() + 5 * HOUR));
  });

  it("Retry-After が延ばす間隔より短ければ、延ばす間隔にする", async () => {
    expect(
      await nextFetchAtOf(
        () => new Response("", { status: 429, headers: { "retry-after": "60" } }),
        0,
      ),
    ).toEqual(new Date(NOW.getTime() + INTERVAL_MS * 2));
  });

  it("長すぎる Retry-After は、取得の間隔の上限（1 日）までにする", async () => {
    expect(
      await nextFetchAtOf(
        () => new Response("", { status: 503, headers: { "retry-after": "999999999" } }),
      ),
    ).toEqual(new Date(NOW.getTime() + MAX_FETCH_INTERVAL_MS));
  });
});

describe("記事の出る時刻の癖（docs/decisions/jobs.md の 11）", () => {
  const DAY = 24 * HOUR;

  async function setupDaily(timeKnown: boolean) {
    const { platform } = createTestPlatform({
      fetch: fakeFetch(() => new Response(null, { status: 304 })).fetch,
      now: () => NOW,
      fetchConfig: { intervalMs: INTERVAL_MS },
    });
    // 40 日前に登録し、1〜28 日前の 07:00 UTC に毎日 1 件
    const { feed } = await insertFeed(platform.db, {
      id: crypto.randomUUID(),
      url: uniqueUrl(),
      now: new Date(NOW.getTime() - 40 * DAY),
    });
    await insertArticles(
      platform.db,
      Array.from({ length: 28 }, (_, i) => ({
        id: crypto.randomUUID(),
        feedId: feed.id,
        guid: `daily-${i}`,
        url: null,
        title: null,
        summary: null,
        author: null,
        publishedAt: new Date(NOW.getTime() - (i + 1) * DAY + 7 * HOUR),
        publishedTimeKnown: timeKnown,
      })),
    );
    return { platform, feed };
  }

  it("毎日 07:00 に出るフィードは、次の 07:00 に取りにいく（304 のときも）", async () => {
    const { platform, feed } = await setupDaily(true);

    expect(await runFetchFeed(platform, feed.id)).toEqual({ status: "not-modified" });
    const saved = await getFeed(platform.db, feed.id);
    expect(saved?.nextFetchAt.toISOString()).toBe("2026-11-14T07:00:00.000Z");
    expect(saved?.fetchIntervalMs).toBe(7 * HOUR);
  });

  it("公開時刻の分からない記事だけなら、記事の出るペースで決める", async () => {
    const { platform, feed } = await setupDaily(false);

    await runFetchFeed(platform, feed.id);
    // 直近 7 日に 7 件：いちばん古い 6 日 17 時間前 ÷ 7 件の 3 分の 1
    const expected = Math.round((6 * DAY + 17 * HOUR) / 7 / 3);
    expect((await getFeed(platform.db, feed.id))?.fetchIntervalMs).toBe(expected);
  });
});
