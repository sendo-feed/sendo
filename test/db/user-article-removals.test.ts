import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { insertArticles } from "../../src/db/articles";
import { setArticleState } from "../../src/db/inbox";
import { addToInbox, createTestPlatform, createUser, subscribeFeed, TEST_USER } from "../helpers";

/*
 * 受信箱の行が消えたときに、トリガーが残す「消した記録」（docs/decisions/sync.md の 3、
 * migrations/0005_user_article_removals_trigger.sql）。
 */

type Platform = ReturnType<typeof createTestPlatform>["platform"];

/** 記事を共有の表に入れ、ユーザーの受信箱に入れる */
async function seed(platform: Platform, feedId: string, ids: string[], userId = TEST_USER.id) {
  const now = new Date();
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
      publishedAt: now,
      createdAt: now,
    })),
  );
  await addToInbox(
    platform,
    ids.map((articleId) => ({ articleId, feedId, publishedAt: now, receivedAt: now, userId })),
  );
}

const maxInboxSeq = async () =>
  (await env.DB.prepare("SELECT max(seq) AS seq FROM user_articles").first<{ seq: number }>())
    ?.seq ?? 0;

const removalsOf = async (userId: string) =>
  (
    await env.DB.prepare(
      "SELECT article_id, seq FROM user_article_removals WHERE user_id = ? ORDER BY seq",
    )
      .bind(userId)
      .all<{ article_id: string; seq: number }>()
  ).results;

const floor = async () =>
  (
    await env.DB.prepare("SELECT floor FROM seq_floors WHERE table_name = 'user_articles'").first<{
      floor: number;
    }>()
  )?.floor;

beforeEach(async () => {
  await env.DB.exec("DELETE FROM feeds");
  await env.DB.exec("DELETE FROM user_article_removals");
});

describe("受信箱から消えた記事の記録", () => {
  it("行が消えると、同じ文の中で記録が残り、番号は受信箱の続きから振られる", async () => {
    const { platform } = createTestPlatform();
    const feed = await subscribeFeed(platform, {});
    await seed(platform, feed.id, ["x", "y"]);
    const before = await maxInboxSeq();

    // どの経路で消しても残る（コードで記録を書かない）
    await env.DB.prepare("DELETE FROM user_articles WHERE article_id = 'x'").run();

    const [removal] = await removalsOf(TEST_USER.id);
    expect(removal?.article_id).toBe("x");
    expect(removal?.seq).toBeGreaterThan(before);
    // 下限も記録の番号まで上がるので、あとから振る番号は記録より大きい
    expect(await floor()).toBe(removal?.seq);
    await setArticleState(platform.db, {
      userId: TEST_USER.id,
      articleId: "y",
      read: true,
      now: new Date(),
    });
    expect(await maxInboxSeq()).toBeGreaterThan(removal?.seq ?? Infinity);
  });

  it("1 つの文で複数の行を消すと、それぞれに別の番号が振られる。同じ記事がまた消えたら振り直す", async () => {
    const { platform } = createTestPlatform();
    const feed = await subscribeFeed(platform, {});
    await seed(platform, feed.id, ["a", "b"]);

    await env.DB.prepare("DELETE FROM user_articles WHERE feed_id = ?").bind(feed.id).run();
    const first = await removalsOf(TEST_USER.id);
    expect(first.map((row) => row.article_id).sort()).toEqual(["a", "b"]);
    expect(new Set(first.map((row) => row.seq)).size).toBe(2);

    // もう一度受信箱に入れて消すと、記録は 1 件のまま番号が進む
    await addToInbox(platform, [
      { articleId: "a", feedId: feed.id, publishedAt: new Date(), receivedAt: new Date() },
    ]);
    await env.DB.prepare("DELETE FROM user_articles WHERE article_id = 'a'").run();
    const again = await removalsOf(TEST_USER.id);
    expect(again).toHaveLength(2);
    const a = again.find((row) => row.article_id === "a");
    expect(a?.seq).toBeGreaterThan(Math.max(...first.map((row) => row.seq)));
  });

  it("ユーザーを消したときは、受信箱の行が連鎖して消えても記録を残さない", async () => {
    const { platform } = createTestPlatform();
    const other = await createUser();
    const feed = await subscribeFeed(platform, { userId: other.id });
    await seed(platform, feed.id, ["o1", "o2"], other.id);

    await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(other.id).run();

    const left = await env.DB.prepare("SELECT count(*) AS n FROM user_articles WHERE user_id = ?")
      .bind(other.id)
      .first<{ n: number }>();
    expect(left?.n).toBe(0);
    expect(await removalsOf(other.id)).toEqual([]);
  });
});
