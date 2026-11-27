import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { insertArticles, recordCurrentFeed } from "../../src/db/articles";
import { noteContentKeys, reserveContents } from "../../src/db/content";
import { deliverNewArticles, setArticleState } from "../../src/db/inbox";
import { recordExtractedPageContent } from "../../src/db/page-contents";
import { articles, userArticles } from "../../src/db/schema";
import {
  configureStorage,
  evictArticles,
  readEvictionCandidates,
  readStorageUsage,
} from "../../src/db/storage";
import { MAX_ITEMS } from "../../src/fetcher/parse-feed";
import { runCleanUp } from "../../src/jobs/clean-up";
import { runFetchFeed } from "../../src/jobs/fetch-feed";
import { canStoreArticles, measureExistingContents, reclaimStorage } from "../../src/jobs/storage";
import { testDb } from "../db";
import {
  addToInbox,
  createTestPlatform,
  createUser,
  fakeFetch,
  statementHook,
  subscribeFeed,
  TEST_USER,
} from "../helpers";

type Platform = ReturnType<typeof createTestPlatform>["platform"];
const NOW = new Date();

async function seed(platform: Platform, ids: string[], feedId?: string) {
  const feed = feedId ? { id: feedId } : await subscribeFeed(platform, {});
  await insertArticles(
    platform.db,
    ids.map((id, i) => ({
      id,
      feedId: feed.id,
      guid: id,
      url: `https://example.com/${id}`,
      title: id,
      summary: null,
      author: null,
      publishedAt: new Date(0),
      createdAt: new Date(i),
      inCurrentFeed: false,
    })),
  );
  await addToInbox(
    platform,
    ids.map((articleId) => ({
      articleId,
      feedId: feed.id,
      publishedAt: new Date(0),
      receivedAt: NOW,
    })),
  );
  return feed;
}
const articleIds = async (platform: Platform) =>
  (await platform.db.select({ id: articles.id }).from(articles).orderBy(articles.createdAt)).map(
    ({ id }) => id,
  );

beforeEach(async () => {
  await testDb.exec("DELETE FROM feeds");
  await testDb.exec("DELETE FROM user_article_removals");
  await testDb.exec("DELETE FROM content_notes");
  await testDb.exec("DELETE FROM content_sizes");
  await testDb.exec(
    "UPDATE storage_usage SET limit_bytes = 268435456, reclaiming = 0, eviction_batches = 0, eviction_day = -1, reclaim_token = null, reclaim_until = 0 WHERE id = 1",
  );
});

describe("容量による記事の保管", () => {
  it("空きがあれば、何年前の未読記事でも残す", async () => {
    const { platform } = createTestPlatform();
    await seed(platform, ["old"]);
    expect((await runCleanUp(platform)).articles).toBe(0);
    expect(await articleIds(platform)).toEqual(["old"]);
    expect(await platform.db.select().from(userArticles)).toHaveLength(1);
  });

  it("取り込みの古い順に選び、誰かのスターとフィード掲載中の記事は保護する", async () => {
    const { platform } = createTestPlatform();
    const other = await createUser();
    const feed = await seed(platform, ["old", "star", "listed", "young"]);
    await addToInbox(platform, [
      { articleId: "star", feedId: feed.id, userId: other.id, publishedAt: NOW, receivedAt: NOW },
    ]);
    await setArticleState(platform.db, {
      userId: other.id,
      articleId: "star",
      starred: true,
      now: NOW,
    });
    await recordCurrentFeed(platform.db, feed.id, ["listed"], 1);
    expect(await readEvictionCandidates(platform.db, 100)).toEqual(["old", "young"]);
    await evictArticles(platform.db, ["old", "star", "listed"]);
    expect(await articleIds(platform)).toEqual(["star", "listed", "young"]);
    expect(
      await platform.db.select().from(userArticles).where(eq(userArticles.articleId, "star")),
    ).toHaveLength(2);
    expect(
      (await testDb.prepare("SELECT article_id FROM user_article_removals").all()).results,
    ).toEqual([{ article_id: "old" }]);
  });

  it("候補を読んだあとに付いたスターも、削除と同じ文の中で保護する", async () => {
    const { platform } = createTestPlatform();
    await seed(platform, ["star"]);
    const candidates = await readEvictionCandidates(platform.db, 10);
    await setArticleState(platform.db, {
      userId: TEST_USER.id,
      articleId: "star",
      starred: true,
      now: NOW,
    });
    expect(await evictArticles(platform.db, candidates)).toEqual({ inbox: 0, articles: 0 });
    expect(await articleIds(platform)).toEqual(["star"]);
  });

  it("受信箱を消したあとで落ちても、再実行で記事を片付けられる", async () => {
    const { platform } = createTestPlatform();
    await seed(platform, ["old"]);
    await platform.db.delete(userArticles).where(eq(userArticles.articleId, "old"));
    expect(await evictArticles(platform.db, ["old"])).toEqual({ inbox: 0, articles: 1 });
    expect(await evictArticles(platform.db, ["old"])).toEqual({ inbox: 0, articles: 0 });
  });

  it("90% で始め、必要な量の古い記事だけを消す", async () => {
    const { platform } = createTestPlatform();
    await seed(
      platform,
      Array.from({ length: 20 }, (_, i) => `a${i}`),
    );
    const usage = await readStorageUsage(platform.db);
    platform.retentionConfig.maxBytes = Math.ceil(usage.bytes / 0.95);
    const result = await reclaimStorage(platform);
    expect(result.articles).toBeGreaterThan(0);
    expect(result.articles).toBeLessThan(20);
    expect(await articleIds(platform)).not.toContain("a0");
    expect(await articleIds(platform)).toContain("a19");
  });

  it("大きな本文を持つ記事は、目標量に必要な件数だけを候補にする", async () => {
    const { platform } = createTestPlatform();
    await seed(platform, ["big", "next"]);
    await recordExtractedPageContent(platform.db, {
      articleId: "big",
      html: "a".repeat(10000),
      now: NOW,
    });
    expect(await readEvictionCandidates(platform.db, 100, 5000)).toEqual(["big"]);
  });

  it("1 日の片付け回数を超えたら残りを次に回す", async () => {
    const { platform } = createTestPlatform();
    await seed(platform, ["old"]);
    platform.retentionConfig.maxBytes = 1;
    await platform.db.run(
      sql`update storage_usage set eviction_day = cast(unixepoch() / 86400 as integer), eviction_batches = 10`,
    );
    expect((await reclaimStorage(platform)).articles).toBe(0);
    expect(await articleIds(platform)).toEqual(["old"]);
  });

  it("解析が打ち切られた場合と、完全に読み切れた場合の掲載状態を分ける", async () => {
    const { platform } = createTestPlatform();
    const feed = await seed(platform, ["old", "listed"]);
    await platform.db.update(articles).set({ inCurrentFeed: true });
    await recordCurrentFeed(platform.db, feed.id, ["listed"], MAX_ITEMS);
    expect(await readEvictionCandidates(platform.db, 10)).toEqual([]);
    await recordCurrentFeed(platform.db, feed.id, ["listed"], 1);
    expect(await readEvictionCandidates(platform.db, 10)).toEqual(["old"]);
  });
});

describe("本文の容量と既存データ", () => {
  it("本文は UTF-8 のバイト数で集計し、消し終えるまで容量を戻さない", async () => {
    const { platform } = createTestPlatform();
    const before = await readStorageUsage(platform.db);
    const body = "日本語";
    await noteContentKeys(platform.db, ["feed/size-test"]);
    expect(
      await reserveContents(platform.db, [
        { key: "feed/size-test", bytes: new TextEncoder().encode(body).length },
      ]),
    ).toEqual(new Set(["feed/size-test"]));
    await platform.content.put("feed/size-test", body);
    expect((await readStorageUsage(platform.db)).bytes - before.bytes).toBe(256 + 9);
    await runCleanUp(platform);
    expect(await platform.content.get("feed/size-test")).toBe(body);
    platform.now = () => new Date(Date.now() + 2 * 60 * 60 * 1000);
    await runCleanUp(platform);
    expect(await platform.content.get("feed/size-test")).toBeNull();
    expect((await readStorageUsage(platform.db)).bytes).toBe(before.bytes);
  });

  it("同時に本文を予約しても、残り容量を超える方は保存しない", async () => {
    const { platform } = createTestPlatform();
    const { bytes } = await readStorageUsage(platform.db);
    await configureStorage(platform.db, bytes + 1000);
    const results = await Promise.all([
      reserveContents(platform.db, [{ key: "feed/reserve-a", bytes: 700 }]),
      reserveContents(platform.db, [{ key: "feed/reserve-b", bytes: 700 }]),
    ]);
    expect(results.reduce((n, result) => n + result.size, 0)).toBe(1);
    expect((await readStorageUsage(platform.db)).bytes).toBeLessThanOrEqual(bytes + 1000);
  });

  it("未集計の本文が残っている間は削除も取り込みも止め、既存本文を少しずつ測る", async () => {
    const { platform } = createTestPlatform();
    await seed(platform, ["old"]);
    await platform.content.put("feed/legacy", "既存本文");
    await platform.db.run(sql`insert into content_sizes (key, bytes) values ('feed/legacy', null)`);
    platform.retentionConfig.maxBytes = 1;
    expect(await canStoreArticles(platform)).toBe(false);
    expect((await reclaimStorage(platform)).articles).toBe(0);
    await measureExistingContents(platform);
    expect((await readStorageUsage(platform.db)).unmeasured).toBe(0);
    expect(
      (
        await platform.db.get<{ bytes: number }>(
          sql`select bytes from content_sizes where key = 'feed/legacy'`,
        )
      )?.bytes,
    ).toBe(12);
  });

  it("抽出した本文の追加と、失敗から成功への更新にも容量上限を適用する", async () => {
    const { platform } = createTestPlatform();
    await seed(platform, ["page"]);
    const { bytes } = await readStorageUsage(platform.db);
    await configureStorage(platform.db, bytes + 300);
    expect(
      await recordExtractedPageContent(platform.db, {
        articleId: "page",
        html: "x".repeat(1000),
        now: NOW,
      }),
    ).toBeNull();
    await platform.db.run(
      sql`insert into page_contents (article_id, status, html, attempted_at) values ('page', 'failed', null, 0)`,
    );
    expect(
      await recordExtractedPageContent(platform.db, {
        articleId: "page",
        html: "x".repeat(1000),
        now: NOW,
      }),
    ).toBeNull();
    await configureStorage(platform.db, bytes + 1256);
    expect(
      await recordExtractedPageContent(platform.db, {
        articleId: "page",
        html: "x".repeat(1000),
        now: NOW,
      }),
    ).toHaveLength(1000);
  });
});

describe("取得の停止と再開", () => {
  it("上限でもフィードの掲載状態を更新し、ETag を進めず、容量を増やすと再開する", async () => {
    const { fetch } = fakeFetch(
      () =>
        new Response(
          '<rss version="2.0"><channel><title>test</title><item><guid>new</guid><title>new</title></item></channel></rss>',
          { headers: { etag: '"next"' } },
        ),
    );
    const { platform, enqueued } = createTestPlatform({ fetch });
    const feed = await seed(platform, ["old"]);
    await platform.db.update(articles).set({ inCurrentFeed: true });
    platform.retentionConfig.maxBytes = 1;
    expect(await runFetchFeed(platform, feed.id)).toEqual({ status: "storage-full" });
    expect(await readEvictionCandidates(platform.db, 10)).toEqual(["old"]);
    expect(
      (
        await platform.db.get<{ etag: string | null }>(
          sql`select etag from feeds where id = ${feed.id}`,
        )
      )?.etag,
    ).toBeNull();
    expect(enqueued).toContainEqual({ type: "clean-up" });
    platform.retentionConfig.maxBytes = 16 * 1024 * 1024;
    expect(await runFetchFeed(platform, feed.id)).toMatchObject({ status: "fetched", inserted: 1 });
    await runFetchFeed(platform, feed.id);
    expect(await articleIds(platform)).toHaveLength(2);
  });
});

describe("受信箱の配布と容量上限", () => {
  it("配布を途中で飛ばさず、容量を増やした再実行で残りが届く", async () => {
    const { platform } = createTestPlatform();
    const feed = await subscribeFeed(platform, {});
    await insertArticles(platform.db, [
      { id: "pending", feedId: feed.id, guid: "pending", publishedAt: NOW },
    ]);
    // 移行した旧記事のように、配布の予約を持たないケース。
    await platform.db
      .update(articles)
      .set({ reservedInboxBytes: 0 })
      .where(eq(articles.id, "pending"));
    const usage = await readStorageUsage(platform.db);
    await configureStorage(platform.db, usage.bytes + 100);
    await expect(deliverNewArticles(platform.db, { feedId: feed.id })).rejects.toThrow();
    expect(await platform.db.select().from(userArticles)).toHaveLength(0);
    expect((await readStorageUsage(platform.db)).bytes).toBe(usage.bytes);
    await configureStorage(platform.db, usage.bytes + 1000);
    await deliverNewArticles(platform.db, { feedId: feed.id });
    expect(await platform.db.select().from(userArticles)).toHaveLength(1);
    expect((await readStorageUsage(platform.db)).bytes).toBe(usage.bytes + 512);
  });
});

describe("容量回収の並行実行", () => {
  it("先行する回収が候補を読む間、別の回収は同じ不足量を計画しない", async () => {
    const { platform } = createTestPlatform();
    await seed(
      platform,
      Array.from({ length: 20 }, (_, i) => `a${i}`),
    );
    const usage = await readStorageUsage(platform.db);
    platform.retentionConfig.maxBytes = Math.ceil(usage.bytes / 0.95);
    let release = () => {};
    let notify = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      notify = resolve;
    });
    // 先行する回収が、所有権を取ったあとで候補を読む文の直前で止まる
    const { db } = statementHook(/a\.reserved_inbox_bytes \+ a\.reserved_inbox_bytes/, async () => {
      notify();
      await held;
    });
    const first = reclaimStorage({ ...platform, db });
    await entered;
    try {
      expect(await reclaimStorage(platform)).toEqual({ inbox: 0, articles: 0 });
    } finally {
      release();
    }
    const result = await first;
    expect(result.articles).toBeGreaterThan(0);
    expect(result.articles).toBeLessThan(20);
    expect((await reclaimStorage(platform)).articles).toBe(0);
  });

  it("所有権を失った実行は、候補を持っていても削除を続けない", async () => {
    const { platform } = createTestPlatform();
    await seed(platform, ["old"]);
    await platform.db.run(sql`update storage_usage set reclaim_token = 'new-owner',
      reclaim_until = cast(unixepoch('subsec') * 1000 as integer) + 60000, limit_bytes = 1`);
    expect(await evictArticles(platform.db, ["old"], "old-owner")).toEqual({
      inbox: 0,
      articles: 0,
    });
    await platform.db.run(sql`update storage_usage set reclaim_until = 0`);
    expect(await evictArticles(platform.db, ["old"], "new-owner")).toEqual({
      inbox: 0,
      articles: 0,
    });
    expect(await articleIds(platform)).toEqual(["old"]);
  });
});

describe("本文の容量不足からの再試行", () => {
  it("本文を予約できない記事は保存済みにせず、容量を増やすと本文ごと取り込む", async () => {
    const html = `<p>${"x".repeat(10000)}</p>`;
    const { fetch } = fakeFetch(
      () =>
        new Response(
          `<rss version="2.0"><channel><title>test</title><item><guid>body</guid><title>title</title><description><![CDATA[${html}]]></description></item></channel></rss>`,
          { headers: { etag: '"body"' } },
        ),
    );
    const { platform } = createTestPlatform({ fetch });
    const feed = await subscribeFeed(platform, {});
    platform.retentionConfig.maxBytes = 4096;
    expect(await runFetchFeed(platform, feed.id)).toEqual({ status: "storage-full" });
    expect(await articleIds(platform)).toEqual([]);
    expect(
      (
        await platform.db.get<{ etag: string | null }>(
          sql`select etag from feeds where id = ${feed.id}`,
        )
      )?.etag,
    ).toBeNull();
    platform.retentionConfig.maxBytes = 32 * 1024;
    expect(await runFetchFeed(platform, feed.id)).toEqual({ status: "fetched", inserted: 1 });
    const row = (await platform.db.select().from(articles))[0];
    expect(row?.contentKey).toBeTruthy();
    expect(await platform.content.get(row?.contentKey ?? "")).toBe(html);
    await runFetchFeed(platform, feed.id);
    expect(await articleIds(platform)).toHaveLength(1);
  });
});

describe("削除目標の容量見積もり", () => {
  it("日本語の長いタイトルも容量に含め、必要以上の件数を消さない", async () => {
    const { platform } = createTestPlatform();
    await seed(
      platform,
      Array.from({ length: 20 }, (_, i) => `a${i}`),
    );
    await platform.db.update(articles).set({ title: "あ".repeat(5000) });
    const usage = await readStorageUsage(platform.db);
    platform.retentionConfig.maxBytes = Math.ceil(usage.bytes / 0.95);
    const result = await reclaimStorage(platform);
    expect(result.articles).toBeGreaterThan(0);
    expect(result.articles).toBeLessThan(5);
    expect(await articleIds(platform)).toContain("a19");
  });
});

describe("記事と受信箱を含む容量予約", () => {
  it("本文だけで容量を使い切らず、保存できる記事を受信箱まで届ける", async () => {
    const html = `<p>${"x".repeat(6900)}</p>`;
    const items = ["one", "two"]
      .map(
        (id) =>
          `<item><guid>${id}</guid><title>${id}</title><description><![CDATA[${html}]]></description></item>`,
      )
      .join("");
    const { fetch } = fakeFetch(
      () =>
        new Response(`<rss version="2.0"><channel><title>test</title>${items}</channel></rss>`, {
          headers: { etag: '"bundle"' },
        }),
    );
    const { platform } = createTestPlatform({ fetch });
    const feed = await subscribeFeed(platform, {});
    platform.retentionConfig.maxBytes = 16 * 1024;
    expect(await runFetchFeed(platform, feed.id)).toEqual({ status: "storage-full" });
    expect(await articleIds(platform)).toHaveLength(1);
    expect(await platform.db.select().from(userArticles)).toHaveLength(1);
    expect((await readStorageUsage(platform.db)).bytes).toBeLessThanOrEqual(16 * 1024);
    expect((await platform.db.select().from(articles))[0]?.reservedInboxBytes).toBe(0);
    platform.retentionConfig.maxBytes = 32 * 1024;
    expect(await runFetchFeed(platform, feed.id)).toEqual({ status: "fetched", inserted: 1 });
    expect(await platform.db.select().from(userArticles)).toHaveLength(2);
    for (const row of await platform.db.select().from(articles)) {
      expect(await platform.content.get(row.contentKey ?? "")).toBe(html);
    }
  });

  it("本文のない記事も、受信箱の分まで確保してから取り込む", async () => {
    const items = Array.from(
      { length: 20 },
      (_, i) => `<item><guid>a${i}</guid><title>title</title></item>`,
    ).join("");
    const { fetch } = fakeFetch(
      () => new Response(`<rss version="2.0"><channel><title>test</title>${items}</channel></rss>`),
    );
    const { platform } = createTestPlatform({ fetch });
    const feed = await subscribeFeed(platform, {});
    platform.retentionConfig.maxBytes = 16 * 1024;
    expect(await runFetchFeed(platform, feed.id)).toEqual({ status: "storage-full" });
    const saved = await articleIds(platform);
    expect(saved.length).toBeGreaterThan(0);
    expect(saved.length).toBeLessThan(20);
    expect(await platform.db.select().from(userArticles)).toHaveLength(saved.length);
    expect((await readStorageUsage(platform.db)).bytes).toBeLessThanOrEqual(16 * 1024);
  });

  it("記事保存後に中断しても、確保した受信箱を上限内で配り直す", async () => {
    const { fetch } = fakeFetch(
      () =>
        new Response(
          '<rss version="2.0"><channel><title>test</title><item><guid>pending</guid><title>title</title></item></channel></rss>',
        ),
    );
    const { platform } = createTestPlatform({ fetch });
    const feed = await subscribeFeed(platform, {});
    await insertArticles(platform.db, [
      { id: "pending", feedId: feed.id, guid: "pending", publishedAt: NOW },
    ]);
    const before = await readStorageUsage(platform.db);
    platform.retentionConfig.maxBytes = before.bytes;
    expect((await platform.db.select().from(articles))[0]?.reservedInboxBytes).toBe(512);
    await runFetchFeed(platform, feed.id);
    expect(await platform.db.select().from(userArticles)).toHaveLength(1);
    expect((await readStorageUsage(platform.db)).bytes).toBe(before.bytes);
    expect((await platform.db.select().from(articles))[0]?.reservedInboxBytes).toBe(0);
  });
});

describe("履歴が多いフィードの配布", () => {
  it("配布済みの履歴が増えても、予約を解放する読み取りは履歴全件にならない", async () => {
    const { platform } = createTestPlatform();
    const feed = await subscribeFeed(platform, {});
    await testDb
      .prepare(`WITH RECURSIVE n(i) AS (
      SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1000
    ) INSERT INTO articles (id, feed_id, guid, published_at, created_at)
      SELECT 'history-' || i, ?, 'history-' || i, 0, 0 FROM n`)
      .bind(feed.id)
      .run();
    await deliverNewArticles(platform.db, { feedId: feed.id });
    // 予約の解放（トリガーの feeds_release_delivery）と同じ文が、予約の残る記事だけの索引を使う
    const plan = await testDb
      .prepare(`EXPLAIN QUERY PLAN UPDATE articles SET reserved_inbox_bytes = 0
        WHERE feed_id = ? AND reserved_inbox_bytes > 0 AND created_at <= ? + 1
          AND NOT EXISTS (
            SELECT 1 FROM subscriptions s WHERE s.feed_id = ? AND s.deleted_at IS NULL
              AND NOT EXISTS (SELECT 1 FROM user_articles u
                WHERE u.article_id = articles.id AND u.user_id = s.user_id)
          )`)
      .bind(feed.id, Date.now(), feed.id)
      .all<{ detail: string }>();
    const details = plan.results.map((row) => row.detail).join("\n");
    expect(details).toMatch(/articles USING INDEX articles_pending_delivery_idx/);
    expect(details).not.toMatch(/SCAN articles/);
  });
});
