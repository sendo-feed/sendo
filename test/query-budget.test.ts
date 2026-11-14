import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { QUERY_BUDGET } from "../src/db/chunk";
import { insertFeeds, MAX_LEASE } from "../src/db/feeds";
import { subscribeMany } from "../src/db/subscriptions";
import { MAX_ITEMS } from "../src/fetcher/parse-feed";
import { runFetchFeed } from "../src/jobs/fetch-feed";
import { runImportFeeds } from "../src/jobs/import-feeds";
import { IMPORT_CHUNK_SIZE, jobSchema } from "../src/jobs/job";
import { enqueueDueFeeds, MAX_LEASE_ROUNDS } from "../src/jobs/schedule";
import {
  createTestPlatform,
  createUser,
  fakeFetch,
  requestApp,
  subscribeFeed,
  TEST_USER,
} from "./helpers";

/**
 * D1 は Worker の 1 回の実行で 50 クエリまで（無料プラン）。
 * 1 回の実行で動く処理が、最悪の場合でも QUERY_BUDGET に収まることを確かめる。
 */
describe("D1 のクエリの上限", () => {
  const NOW = new Date("2026-11-14T00:00:00Z");

  beforeEach(async () => {
    await env.DB.exec("DELETE FROM feeds");
    await env.DB.exec("DELETE FROM folders");
  });

  it("インポートのジョブ：既存のフィードを 1 件ずつ別のフォルダに入れる最悪の場合", async () => {
    const { platform, queryCount, resetQueryCount } = createTestPlatform({ now: () => NOW });
    const entries = Array.from({ length: IMPORT_CHUNK_SIZE }, (_, i) => ({
      url: `https://f${i}.example/feed`,
      folder: `Folder ${i}`,
    }));
    await runImportFeeds(platform, {
      userId: TEST_USER.id,
      entries: entries.map(({ url }) => ({ url, folder: null })),
    });
    resetQueryCount();

    await runImportFeeds(platform, { userId: TEST_USER.id, entries });

    expect(queryCount()).toBeLessThanOrEqual(QUERY_BUDGET);
  });

  it("取得のジョブ：記事が上限まである場合", async () => {
    const items = Array.from(
      { length: MAX_ITEMS },
      (_, i) => `<item><title>t${i}</title><link>https://blog.example/${i}</link></item>`,
    ).join("");
    const { fetch } = fakeFetch(
      () => new Response(`<rss version="2.0"><channel><title>b</title>${items}</channel></rss>`),
    );
    const { platform, queryCount, resetQueryCount } = createTestPlatform({
      fetch,
      now: () => NOW,
    });
    // 購読している人が 2 人いても、受信箱に配るクエリの数は変わらない
    const feed = await subscribeFeed(platform, { url: "https://blog.example/feed", now: NOW });
    const other = await createUser();
    await subscribeFeed(platform, { url: feed.url, userId: other.id, now: NOW });
    resetQueryCount();

    expect(await runFetchFeed(platform, feed.id)).toEqual({
      status: "fetched",
      inserted: MAX_ITEMS,
    });
    expect(queryCount()).toBeLessThanOrEqual(QUERY_BUDGET);
  });

  it("定期実行：時期の来たフィードが 1 回で積める数より多い場合は、残りを次に回す", async () => {
    const { platform, enqueued, queryCount, resetQueryCount } = createTestPlatform({
      now: () => NOW,
    });
    const capacity = MAX_LEASE * MAX_LEASE_ROUNDS;
    const ids = Array.from({ length: capacity + 5 }, (_, i) => `f${i}`);
    await insertFeeds(
      platform.db,
      ids.map((id) => ({
        id,
        url: `https://${id}.example/feed`,
        nextFetchAt: NOW,
        createdAt: NOW,
      })),
    );
    await subscribeMany(platform.db, {
      userId: TEST_USER.id,
      rows: ids.map((feedId) => ({ feedId, folderId: null })),
      now: NOW,
    });
    resetQueryCount();

    expect(await enqueueDueFeeds(platform)).toBe(capacity);
    expect(queryCount()).toBeLessThanOrEqual(QUERY_BUDGET);
    expect(enqueued).toHaveLength(capacity);

    expect(await enqueueDueFeeds(platform)).toBe(5);
  });

  it("OPML のインポートの API は認証のほかに DB を使わず、受け取る側の検証を通るジョブだけを積む", async () => {
    const { platform, enqueued, queryCount } = createTestPlatform();
    const outlines = Array.from(
      { length: 60 },
      (_, i) =>
        `<outline text="${"📁".repeat(150)}"><outline text="f" xmlUrl="https://f${i}.example/${"あ".repeat(i * 10)}"/></outline>`,
    ).join("");

    const res = await requestApp(platform, "/api/v1/opml", {
      method: "POST",
      body: `<opml version="2.0"><body>${outlines}</body></opml>`,
      headers: { "content-type": "text/x-opml" },
    });

    expect(res.status).toBe(202);
    // 認証のトークンの照合（1）と、最後に使った時刻の書き直し（1 時間に 1 回）だけ
    expect(queryCount()).toBeLessThanOrEqual(2);
    expect(enqueued.length).toBeGreaterThan(0);
    for (const job of enqueued) {
      expect(jobSchema.safeParse(job).success).toBe(true);
    }
  });

  it("同期の API：最初の同期でも差分でも、上限に収まる", async () => {
    const { platform, queryCount, resetQueryCount } = createTestPlatform();
    await subscribeFeed(platform, {});
    resetQueryCount();

    const first = await requestApp(platform, "/api/v1/sync");
    expect(queryCount()).toBeLessThanOrEqual(QUERY_BUDGET);
    const { cursor } = (await first.json()) as { cursor: string };

    resetQueryCount();
    await requestApp(platform, `/api/v1/sync?cursor=${cursor}`);
    expect(queryCount()).toBeLessThanOrEqual(QUERY_BUDGET);
  });
});
