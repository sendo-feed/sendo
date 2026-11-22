import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { feeds, userArticles } from "../../../src/db/schema";
import { runFetchFeed } from "../../../src/jobs/fetch-feed";
import { testDatabase, testDb } from "../../db";
import { createTestPlatform, fakeFetch, requestApp, subscribeFeed, TEST_USER } from "../../helpers";

/**
 * 本番と同じ openDatabase で開いた DB（test/db.ts）に、重なった書き込みを流す
 * （sendo-feed/sendo#215）。1 つのプロセスの中で書き込みが重なっても、SQLITE_BUSY で落ちない
 */
const RSS = (n: number) => `<rss version="2.0"><channel><title>Feed ${n}</title>
  <item><title>one</title><link>https://busy-${n}.example/1</link><guid>1</guid></item>
  <item><title>two</title><link>https://busy-${n}.example/2</link><guid>2</guid></item>
</channel></rss>`;

beforeEach(async () => {
  await testDb.exec("DELETE FROM feeds");
});

describe("重なった呼び出しの接続（sendo-feed/sendo#215）", () => {
  it("どの呼び出しでも、busy_timeout と外部キーが効いている", async () => {
    const { client } = testDatabase;
    const timeouts = await Promise.all(
      Array.from({ length: 10 }, () => client.execute("PRAGMA busy_timeout")),
    );
    const foreignKeys = await Promise.all(
      Array.from({ length: 10 }, () => client.execute("PRAGMA foreign_keys")),
    );
    expect(timeouts.map((r) => Number(r.rows[0]?.[0]))).toEqual(Array(10).fill(5000));
    expect(foreignKeys.map((r) => Number(r.rows[0]?.[0]))).toEqual(Array(10).fill(1));
  });

  it("取得の仕事と、既読・スターの API が重なっても、SQLITE_BUSY で落ちない", async () => {
    const site = fakeFetch((url) => {
      const n = Number(new URL(url).pathname.match(/\d+/)?.[0]);
      return new Response(RSS(n));
    });
    const { platform } = createTestPlatform({ fetch: site.fetch });
    const ids: string[] = [];
    for (let n = 0; n < 20; n++) {
      const feed = await subscribeFeed(platform, { url: `https://busy.example/${n}.xml` });
      await runFetchFeed(platform, feed.id);
      ids.push(feed.id);
    }
    // 次の取得は、条件付きでない取得にする（取得の時刻を戻す）
    await platform.db
      .update(feeds)
      .set({ lastFetchedAt: null, nextFetchAt: new Date(0) })
      .run();
    const articles = await platform.db
      .select({ id: userArticles.articleId })
      .from(userArticles)
      .where(eq(userArticles.userId, TEST_USER.id))
      .all();
    expect(articles.length).toBe(40);

    const results = await Promise.allSettled([
      ...ids.map((id) => runFetchFeed(platform, id)),
      ...articles.map(({ id }, i) =>
        requestApp(platform, `/api/v1/articles/${id}`, {
          method: "PATCH",
          json: i % 2 === 0 ? { read: true } : { starred: true },
        }).then((res) => {
          if (res.status !== 200) throw new Error(`status ${res.status}`);
        }),
      ),
    ]);
    const failures = results.flatMap((r) => (r.status === "rejected" ? [String(r.reason)] : []));
    expect(failures).toEqual([]);
  });
});
