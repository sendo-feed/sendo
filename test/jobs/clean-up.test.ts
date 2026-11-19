import { beforeEach, describe, expect, it } from "vitest";
import { insertArticles } from "../../src/db/articles";
import { readRemovalHorizon } from "../../src/db/retention";
import { unsubscribe } from "../../src/db/subscriptions";
import { runJob } from "../../src/jobs";
import { runCleanUp } from "../../src/jobs/clean-up";
import { CLEAN_UP_HOUR_UTC, enqueueDailyCleanUp } from "../../src/jobs/schedule";
import { testDb } from "../db";
import { addToInbox, createTestPlatform, subscribeFeed, TEST_USER } from "../helpers";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-11-14T00:00:00Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY);

type Platform = ReturnType<typeof createTestPlatform>["platform"];

async function seed(platform: Platform, feedId: string, ids: string[], createdAt: Date) {
  await insertArticles(
    platform.db,
    ids.map((id) => ({
      id,
      feedId,
      guid: id,
      url: null,
      title: id,
      summary: null,
      author: null,
      publishedAt: createdAt,
      createdAt,
    })),
  );
  await addToInbox(
    platform,
    ids.map((articleId) => ({ articleId, feedId, publishedAt: createdAt, receivedAt: createdAt })),
  );
}

const count = async (sql: string) =>
  (await testDb.prepare(sql).first<{ n: number }>())?.n ?? Number.NaN;

beforeEach(async () => {
  await testDb.exec("DELETE FROM feeds");
  await testDb.exec("DELETE FROM user_article_removals");
  await testDb.exec("DELETE FROM removal_horizons");
});

describe("runCleanUp", () => {
  it("空きがあれば古い記事を残し、同期の古い削除記録だけを片付ける", async () => {
    const { platform } = createTestPlatform({ now: () => NOW });
    const feed = await subscribeFeed(platform, {});
    await seed(platform, feed.id, ["old", "young"], daysAgo(120));
    await testDb.exec("UPDATE articles SET created_at = 0 WHERE id = 'old'");
    await testDb
      .prepare("UPDATE articles SET created_at = ? WHERE id = 'young'")
      .bind(daysAgo(10).getTime())
      .run();
    await unsubscribe(platform.db, { userId: TEST_USER.id, feedId: feed.id, now: NOW });
    // 購読をやめると、受信箱の行は消える（消した記録が残る）。消えた時刻を 31 日前にする
    await testDb
      .prepare("UPDATE user_article_removals SET removed_at = ?")
      .bind(daysAgo(31).getTime())
      .run();

    expect(await runCleanUp(platform)).toEqual({
      inbox: 0,
      articles: 0,
      removals: 2,
      settings: 0,
      savedPages: 0,
      activity: 0,
      contents: 0,
    });
    expect(await count("SELECT count(*) AS n FROM articles")).toBe(2);
    expect(await count("SELECT count(*) AS n FROM user_article_removals")).toBe(0);
    expect(await readRemovalHorizon(platform.db, TEST_USER.id)).toBeGreaterThan(0);
  });

  it("キューの仕事として動く", async () => {
    const { platform } = createTestPlatform({ now: () => NOW });

    await expect(runJob(platform, { type: "clean-up" })).resolves.toBeUndefined();
  });
});

describe("enqueueDailyCleanUp", () => {
  it("片付けの時刻の最初の定期実行でだけ、片付けの仕事を積む", async () => {
    const { platform, enqueued } = createTestPlatform();
    const at = (hour: number, minute: number) => new Date(Date.UTC(2026, 10, 14, hour, minute));

    expect(await enqueueDailyCleanUp(platform, at(CLEAN_UP_HOUR_UTC, 0))).toBe(true);
    expect(await enqueueDailyCleanUp(platform, at(CLEAN_UP_HOUR_UTC, 10))).toBe(false);
    expect(await enqueueDailyCleanUp(platform, at(CLEAN_UP_HOUR_UTC - 1, 0))).toBe(false);
    expect(enqueued).toEqual([{ type: "clean-up" }]);
  });
});
