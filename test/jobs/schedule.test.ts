import { describe, expect, it } from "vitest";
import { getFeed, insertFeed, MAX_LEASE } from "../../src/db/feeds";
import { unsubscribe } from "../../src/db/subscriptions";
import { enqueueDueFeeds, runScheduled } from "../../src/jobs/schedule";
import { testDb } from "../db";
import { createTestPlatform, subscribeFeed, TEST_USER, uniqueUrl } from "../helpers";

const NOW = new Date("2026-11-14T00:00:00Z");

describe("enqueueDueFeeds", () => {
  it("時期の来たフィードだけを積み、続けて呼んでも二重に積まない", async () => {
    await testDb.exec("DELETE FROM feeds");
    const { platform, enqueued } = createTestPlatform({ now: () => NOW });
    const due = await subscribeFeed(platform, { feedId: "due", now: NOW });
    await subscribeFeed(platform, { feedId: "later", now: new Date(NOW.getTime() + 60_000) });

    expect(await enqueueDueFeeds(platform)).toBe(1);
    expect(enqueued).toEqual([{ type: "fetch-feed", feedId: due.id }]);

    // 借りている間は、次の定期実行でも積まない
    expect(await enqueueDueFeeds(platform)).toBe(0);
    expect((await getFeed(platform.db, "due"))?.nextFetchAt.getTime()).toBeGreaterThan(
      NOW.getTime(),
    );
  });

  it("定期実行が重なっても、同じフィードを二重に借りない", async () => {
    await testDb.exec("DELETE FROM feeds");
    const { platform, enqueued } = createTestPlatform({ now: () => NOW });
    const feed = await subscribeFeed(platform, { now: NOW });

    const results = await Promise.all([enqueueDueFeeds(platform), enqueueDueFeeds(platform)]);
    expect(results.sort()).toEqual([0, 1]);
    expect(enqueued).toEqual([{ type: "fetch-feed", feedId: feed.id }]);
  });

  it("一度に借りられる数を超えても、すべて積む", async () => {
    await testDb.exec("DELETE FROM feeds");
    const { platform, enqueued } = createTestPlatform({ now: () => NOW });
    const count = MAX_LEASE + 5;
    for (let i = 0; i < count; i++) {
      await subscribeFeed(platform, { feedId: `f${i}`, now: NOW });
    }

    expect(await enqueueDueFeeds(platform)).toBe(count);
    const ids = enqueued.flatMap((job) => (job.type === "fetch-feed" ? [job.feedId] : []));
    expect(new Set(ids).size).toBe(count);
  });

  it("購読している人がいないフィードは積まない", async () => {
    await testDb.exec("DELETE FROM feeds");
    const { platform, enqueued } = createTestPlatform({ now: () => NOW });
    await insertFeed(platform.db, { id: "orphan", url: uniqueUrl(), now: NOW });
    const ended = await subscribeFeed(platform, { feedId: "ended", now: NOW });
    await unsubscribe(platform.db, { userId: TEST_USER.id, feedId: ended.id, now: NOW });

    expect(await enqueueDueFeeds(platform)).toBe(0);
    expect(enqueued).toEqual([]);
  });
});

describe("runScheduled（docs/decisions/jobs.md の 12）", () => {
  const at = (time: string) => new Date(`2026-11-14T${time}:00Z`);

  it("5 分の区切りでは、時期の来たフィードと、訳文の手入れを積む", async () => {
    await testDb.exec("DELETE FROM feeds");
    const { platform, enqueued } = createTestPlatform({ now: () => NOW });
    const feed = await subscribeFeed(platform, { now: NOW });

    await runScheduled(platform, at("12:05"));
    expect(enqueued).toEqual([
      { type: "fetch-feed", feedId: feed.id },
      { type: "maintain-translations" },
    ]);
  });

  it("10 分の区切りでは、言語の判定と検索の索引も積む", async () => {
    await testDb.exec("DELETE FROM feeds");
    const { platform, enqueued } = createTestPlatform({ now: () => NOW });
    const feed = await subscribeFeed(platform, { now: NOW });

    await runScheduled(platform, at("12:10"));
    expect(enqueued).toEqual([
      { type: "fetch-feed", feedId: feed.id },
      { type: "maintain-translations" },
      { type: "detect-article-languages" },
      { type: "index-article-search" },
    ]);
  });
});
