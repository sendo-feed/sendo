import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { insertArticles } from "../../src/db/articles";
import { collectRemovals, raiseRemovalHorizons, readRemovalHorizon } from "../../src/db/retention";
import { addToInbox, createTestPlatform, createUser, subscribeFeed, TEST_USER } from "../helpers";

/* 古い記事の片付け（docs/decisions/retention.md） */

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-11-14T00:00:00Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY);

type Platform = ReturnType<typeof createTestPlatform>["platform"];

/** 取り込み時刻を決めて記事を入れ、受信箱にも入れる */
async function seed(
  platform: Platform,
  feedId: string,
  rows: { id: string; createdAt: Date }[],
  userIds: string[] = [TEST_USER.id],
) {
  await insertArticles(
    platform.db,
    rows.map(({ id, createdAt }) => ({
      id,
      feedId,
      guid: `guid-${id}`,
      url: null,
      title: id,
      summary: null,
      author: null,
      publishedAt: createdAt,
      createdAt,
    })),
  );
  for (const userId of userIds) {
    await addToInbox(
      platform,
      rows.map(({ id, createdAt }) => ({
        articleId: id,
        feedId,
        publishedAt: createdAt,
        receivedAt: createdAt,
        userId,
      })),
    );
  }
}

const removalsOf = async (userId = TEST_USER.id) =>
  (
    await env.DB.prepare(
      "SELECT article_id FROM user_article_removals WHERE user_id = ? ORDER BY article_id",
    )
      .bind(userId)
      .all<{ article_id: string }>()
  ).results.map((row) => row.article_id);

beforeEach(async () => {
  await env.DB.exec("DELETE FROM feeds");
  await env.DB.exec("DELETE FROM user_article_removals");
  await env.DB.exec("DELETE FROM removal_horizons");
});

describe("同期の削除記録の回収", () => {
  it("消した記録：下限を引き上げてから、下限までの記録を消す", async () => {
    const { platform } = createTestPlatform();
    const feed = await subscribeFeed(platform, {});
    await seed(platform, feed.id, [
      { id: "old", createdAt: daysAgo(120) },
      { id: "new", createdAt: daysAgo(120) },
    ]);
    await env.DB.exec("DELETE FROM user_articles WHERE article_id = 'old'");
    const cutoff = new Date();
    await env.DB.exec("DELETE FROM user_articles WHERE article_id = 'new'");
    // 消えた時刻を決めて書き直す（記録は DB の時計で残る）
    await env.DB.prepare("UPDATE user_article_removals SET removed_at = ? WHERE article_id = 'old'")
      .bind(cutoff.getTime() - 1)
      .run();
    await env.DB.prepare("UPDATE user_article_removals SET removed_at = ? WHERE article_id = 'new'")
      .bind(cutoff.getTime() + 1)
      .run();
    const oldSeq = (
      await env.DB.prepare("SELECT seq FROM user_article_removals WHERE article_id = 'old'").first<{
        seq: number;
      }>()
    )?.seq;

    expect(await readRemovalHorizon(platform.db, TEST_USER.id)).toBe(0);
    // 下限を引き上げるまでは、消さない
    expect(await collectRemovals(platform.db, { limit: 500 })).toBe(0);

    await raiseRemovalHorizons(platform.db, { before: cutoff });
    expect(await readRemovalHorizon(platform.db, TEST_USER.id)).toBe(oldSeq);
    expect(await collectRemovals(platform.db, { limit: 500 })).toBe(1);
    expect(await removalsOf()).toEqual(["new"]);

    // 下限は下がらない
    await raiseRemovalHorizons(platform.db, { before: new Date(0) });
    expect(await readRemovalHorizon(platform.db, TEST_USER.id)).toBe(oldSeq);
  });

  it("消した記録：回収の下限は人ごと。記録のない人の下限は上がらない", async () => {
    const { platform } = createTestPlatform();
    const other = await createUser();
    const feed = await subscribeFeed(platform, {});
    await seed(platform, feed.id, [{ id: "x", createdAt: daysAgo(120) }]);
    await env.DB.exec("DELETE FROM user_articles WHERE article_id = 'x'");

    await raiseRemovalHorizons(platform.db, { before: new Date(Date.now() + DAY) });

    expect(await readRemovalHorizon(platform.db, TEST_USER.id)).toBeGreaterThan(0);
    expect(await readRemovalHorizon(platform.db, other.id)).toBe(0);
  });
});
