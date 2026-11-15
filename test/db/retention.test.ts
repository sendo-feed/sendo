import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { insertArticles } from "../../src/db/articles";
import { setArticleState } from "../../src/db/inbox";
import {
  collectRemovals,
  deleteExpiredArticles,
  planFeedCleanUp,
  raiseRemovalHorizons,
  readRemovalHorizon,
  removeExpiredFromInbox,
  sweepExpiredInbox,
  sweepUnsubscribedArticles,
} from "../../src/db/retention";
import { articles, userArticles } from "../../src/db/schema";
import { unsubscribe } from "../../src/db/subscriptions";
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

const inboxOf = async (platform: Platform, userId = TEST_USER.id) =>
  (
    await platform.db
      .select({ id: userArticles.articleId })
      .from(userArticles)
      .where(eq(userArticles.userId, userId))
      .all()
  )
    .map((row) => row.id)
    .sort();

const articlesOf = async (platform: Platform, feedId: string) =>
  (
    await platform.db
      .select({ id: articles.id })
      .from(articles)
      .where(eq(articles.feedId, feedId))
      .all()
  )
    .map((row) => row.id)
    .sort();

const removalsOf = async (userId = TEST_USER.id) =>
  (
    await env.DB.prepare(
      "SELECT article_id FROM user_article_removals WHERE user_id = ? ORDER BY article_id",
    )
      .bind(userId)
      .all<{ article_id: string }>()
  ).results.map((row) => row.article_id);

const star = (platform: Platform, articleId: string, userId = TEST_USER.id) =>
  setArticleState(platform.db, { userId, articleId, starred: true, now: NOW });

beforeEach(async () => {
  await env.DB.exec("DELETE FROM feeds");
  await env.DB.exec("DELETE FROM user_article_removals");
  await env.DB.exec("DELETE FROM removal_horizons");
});

describe("planFeedCleanUp", () => {
  const HOUR = 60 * 60 * 1000;
  const input = { now: NOW, retentionMs: 90 * DAY, stepMs: 2 * HOUR };

  it("期限（今から期間を引いた時刻）を過ぎていなければ、片付けない", () => {
    const feed = { cleanedUntil: null, createdAt: daysAgo(10) };

    expect(planFeedCleanUp(feed, input)).toBeNull();
  });

  it("前回の位置から、進める幅までずつ進める", () => {
    const feed = { cleanedUntil: daysAgo(120), createdAt: daysAgo(200) };

    expect(planFeedCleanUp(feed, input)).toEqual({
      from: daysAgo(120),
      until: new Date(daysAgo(120).getTime() + 2 * HOUR),
    });
  });

  it("期限より先へは進めない", () => {
    const feed = { cleanedUntil: new Date(daysAgo(90).getTime() - HOUR), createdAt: daysAgo(200) };

    expect(planFeedCleanUp(feed, input)?.until).toEqual(daysAgo(90));
    expect(planFeedCleanUp({ ...feed, cleanedUntil: daysAgo(90) }, input)).toBeNull();
  });

  it("まだ片付けたことがなければ、フィードを登録した時刻の少し前から始める", () => {
    const feed = { cleanedUntil: null, createdAt: daysAgo(100) };

    const window = planFeedCleanUp(feed, input);

    expect(window?.from.getTime()).toBeLessThan(daysAgo(100).getTime());
    expect(window?.until.getTime()).toBe((window?.from.getTime() ?? 0) + 2 * HOUR);
  });
});

describe("removeExpiredFromInbox", () => {
  it("範囲に入る記事を、スターの付いていない受信箱から消し、消した記録を残す", async () => {
    const { platform } = createTestPlatform();
    const other = await createUser();
    const feed = await subscribeFeed(platform, {});
    await subscribeFeed(platform, { url: feed.url, userId: other.id });
    await seed(
      platform,
      feed.id,
      [
        { id: "before", createdAt: daysAgo(100) },
        { id: "unread", createdAt: daysAgo(95) },
        { id: "read", createdAt: daysAgo(95) },
        { id: "starred", createdAt: daysAgo(95) },
        { id: "after", createdAt: daysAgo(80) },
      ],
      [TEST_USER.id, other.id],
    );
    await setArticleState(platform.db, {
      userId: TEST_USER.id,
      articleId: "read",
      read: true,
      now: NOW,
    });
    // スターは人ごと。付けた人の受信箱にだけ残る
    await star(platform, "starred");

    await removeExpiredFromInbox(platform.db, {
      feedId: feed.id,
      window: { from: daysAgo(99), until: daysAgo(90) },
    });

    expect(await inboxOf(platform)).toEqual(["after", "before", "starred"]);
    expect(await inboxOf(platform, other.id)).toEqual(["after", "before"]);
    // 同期でクライアントに伝わる
    expect(await removalsOf()).toEqual(["read", "unread"]);
    // 記事（共有）には触れない
    expect(await articlesOf(platform, feed.id)).toHaveLength(5);
  });

  it("ほかのフィードの記事には触れない", async () => {
    const { platform } = createTestPlatform();
    const feed = await subscribeFeed(platform, {});
    const other = await subscribeFeed(platform, {});
    await seed(platform, feed.id, [{ id: "mine", createdAt: daysAgo(95) }]);
    await seed(platform, other.id, [{ id: "theirs", createdAt: daysAgo(95) }]);

    await removeExpiredFromInbox(platform.db, {
      feedId: feed.id,
      window: { from: daysAgo(99), until: daysAgo(90) },
    });

    expect(await inboxOf(platform)).toEqual(["theirs"]);
  });
});

describe("deleteExpiredArticles", () => {
  it("受信箱に残っておらず、フィードにもう載っていない記事だけを消す", async () => {
    const { platform } = createTestPlatform();
    const feed = await subscribeFeed(platform, {});
    await seed(platform, feed.id, [
      { id: "gone", createdAt: daysAgo(95) },
      { id: "listed", createdAt: daysAgo(95) },
      { id: "starred", createdAt: daysAgo(95) },
      { id: "young", createdAt: daysAgo(80) },
    ]);
    await star(platform, "starred");
    await removeExpiredFromInbox(platform.db, {
      feedId: feed.id,
      window: { from: daysAgo(99), until: daysAgo(90) },
    });

    await deleteExpiredArticles(platform.db, {
      feedId: feed.id,
      until: daysAgo(90),
      currentGuids: ["guid-listed", "guid-young"],
    });

    // フィードに載っている記事は、受信箱から消えても行を残す（次の取得で入り直さないように）
    expect(await articlesOf(platform, feed.id)).toEqual(["listed", "starred", "young"]);
  });

  it("フィードに載っている記事が多くても、変数の数の上限に触れない", async () => {
    const { platform } = createTestPlatform();
    const feed = await subscribeFeed(platform, {});
    await seed(platform, feed.id, [{ id: "gone", createdAt: daysAgo(95) }], []);
    const currentGuids = Array.from({ length: 300 }, (_, i) => `https://blog.example/${i}`);

    await deleteExpiredArticles(platform.db, { feedId: feed.id, until: daysAgo(90), currentGuids });

    expect(await articlesOf(platform, feed.id)).toEqual([]);
  });
});

describe("1 日 1 回の片付け", () => {
  it("sweepExpiredInbox：範囲を過ぎてからスターが外された記事も、受信箱から消す", async () => {
    const { platform } = createTestPlatform();
    const feed = await subscribeFeed(platform, {});
    await seed(platform, feed.id, [
      { id: "unstarred", createdAt: daysAgo(120) },
      { id: "starred", createdAt: daysAgo(120) },
      { id: "young", createdAt: daysAgo(10) },
    ]);
    await star(platform, "starred");

    expect(await sweepExpiredInbox(platform.db, { before: daysAgo(90), limit: 500 })).toBe(1);
    expect(await inboxOf(platform)).toEqual(["starred", "young"]);
  });

  it("sweepExpiredInbox：1 つの文で消すのは limit 件まで", async () => {
    const { platform } = createTestPlatform();
    const feed = await subscribeFeed(platform, {});
    await seed(
      platform,
      feed.id,
      Array.from({ length: 5 }, (_, i) => ({ id: `a${i}`, createdAt: daysAgo(120) })),
    );

    expect(await sweepExpiredInbox(platform.db, { before: daysAgo(90), limit: 3 })).toBe(3);
    expect(await sweepExpiredInbox(platform.db, { before: daysAgo(90), limit: 3 })).toBe(2);
    expect(await inboxOf(platform)).toEqual([]);
  });

  it("sweepUnsubscribedArticles：誰も購読していないフィードの記事だけを消す", async () => {
    const { platform } = createTestPlatform();
    const subscribed = await subscribeFeed(platform, {});
    const abandoned = await subscribeFeed(platform, {});
    await seed(platform, subscribed.id, [{ id: "kept", createdAt: daysAgo(120) }], []);
    await seed(platform, abandoned.id, [
      { id: "old", createdAt: daysAgo(120) },
      { id: "starred", createdAt: daysAgo(120) },
      { id: "young", createdAt: daysAgo(10) },
    ]);
    await star(platform, "starred");
    await unsubscribe(platform.db, { userId: TEST_USER.id, feedId: abandoned.id, now: NOW });

    expect(await sweepUnsubscribedArticles(platform.db, { before: daysAgo(90), limit: 500 })).toBe(
      1,
    );
    expect(await articlesOf(platform, abandoned.id)).toEqual(["starred", "young"]);
    // 購読されているフィードは、フィードに載っているかを確かめられる取得のジョブに任せる
    expect(await articlesOf(platform, subscribed.id)).toEqual(["kept"]);
  });

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
