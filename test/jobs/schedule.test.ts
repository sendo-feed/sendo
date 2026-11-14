import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getFeed, insertFeed, MAX_LEASE } from "../../src/db/feeds";
import { enqueueDueFeeds } from "../../src/jobs/schedule";
import { createTestPlatform, uniqueUrl } from "../helpers";

const NOW = new Date("2026-11-14T00:00:00Z");

describe("enqueueDueFeeds", () => {
  it("時期の来たフィードだけを積み、続けて呼んでも二重に積まない", async () => {
    await env.DB.exec("DELETE FROM feeds");
    const { platform, enqueued } = createTestPlatform({ now: () => NOW });
    const due = await insertFeed(platform.db, { id: "due", url: uniqueUrl(), now: NOW });
    await insertFeed(platform.db, {
      id: "later",
      url: uniqueUrl(),
      now: new Date(NOW.getTime() + 60_000),
    });

    expect(await enqueueDueFeeds(platform)).toBe(1);
    expect(enqueued).toEqual([{ type: "fetch-feed", feedId: due.feed.id }]);

    // 借りている間は、次の定期実行でも積まない
    expect(await enqueueDueFeeds(platform)).toBe(0);
    expect((await getFeed(platform.db, "due"))?.nextFetchAt.getTime()).toBeGreaterThan(
      NOW.getTime(),
    );
  });

  it("一度に借りられる数を超えても、すべて積む", async () => {
    await env.DB.exec("DELETE FROM feeds");
    const { platform, enqueued } = createTestPlatform({ now: () => NOW });
    const count = MAX_LEASE + 5;
    for (let i = 0; i < count; i++) {
      await insertFeed(platform.db, { id: `f${i}`, url: uniqueUrl(), now: NOW });
    }

    expect(await enqueueDueFeeds(platform)).toBe(count);
    const ids = enqueued.flatMap((job) => (job.type === "fetch-feed" ? [job.feedId] : []));
    expect(new Set(ids).size).toBe(count);
  });
});
