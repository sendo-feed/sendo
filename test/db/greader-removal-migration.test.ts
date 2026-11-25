import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { expect, it } from "vitest";
import { createAccessToken } from "../../src/db/tokens";
import { runFetchFeed } from "../../src/jobs/fetch-feed";
import { openDatabase } from "../../src/platform/node/database";
import { MIGRATIONS_DIR } from "../db";
import { createTestPlatform, fakeFetch, requestApp, subscribeFeed } from "../helpers";

it("起動時の移行で互換用 ID を削除し、記事と受信箱を使い続けられる", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "sendo-greader-migration-"));
  try {
    const oldMigrations = path.join(directory, "migrations");
    const oldMeta = path.join(oldMigrations, "meta");
    const url = `file:${path.join(directory, "sendo.db")}`;
    await mkdir(oldMeta, { recursive: true });

    const journal = JSON.parse(
      await readFile(path.join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8"),
    ) as { entries: { tag: string }[] };
    const index = journal.entries.findIndex(({ tag }) =>
      tag.endsWith("_remove-google-reader-item-id"),
    );
    expect(index).toBeGreaterThan(0);
    const entries = journal.entries.slice(0, index);
    await writeFile(path.join(oldMeta, "_journal.json"), JSON.stringify({ ...journal, entries }));
    for (const { tag } of entries) {
      const filename = `${tag}.sql`;
      await symlink(path.join(MIGRATIONS_DIR, filename), path.join(oldMigrations, filename));
    }

    const now = new Date("2026-11-25T00:00:00Z");
    const articleId = crypto.randomUUID();
    const feedId = crypto.randomUUID();
    const feedUrl = "https://example.com/feed.xml";
    const userId = crypto.randomUUID();
    const old = await openDatabase(url, { migrationsFolder: oldMigrations });
    let token: string;
    let cursor: string;
    try {
      const { platform } = createTestPlatform({ db: old.db, now: () => now });
      await old.db.run(sql`insert into users (id, email, created_at) values
        (${userId}, 'reader@example.com', ${now.getTime()})`);
      ({ token } = await createAccessToken(old.db, { userId, name: "旧トークン", now }));
      await subscribeFeed(platform, { userId, feedId, url: feedUrl, now });
      await old.db.run(sql`insert into articles (id, feed_id, guid, item_id, title, published_at, created_at)
        values (${articleId}, ${feedId}, 'old', 15, '移行前の記事', ${now.getTime()}, ${now.getTime()})`);
      await old.db.run(sql`insert into user_articles
        (user_id, article_id, feed_id, published_at, created_at, seq, read_seq)
        values (${userId}, ${articleId}, ${feedId}, ${now.getTime()}, ${now.getTime()}, 1, 1)`);
      const updated = await requestApp(platform, `/api/v1/articles/${articleId}`, {
        method: "PATCH",
        token,
        json: { read: true, starred: true },
      });
      expect(updated.status).toBe(200);
      const initial = await requestApp(platform, "/api/v1/sync", { token });
      expect(initial.status).toBe(200);
      const synced = (await initial.json()) as { cursor: string; hasMore: boolean };
      expect(synced.hasMore).toBe(false);
      cursor = synced.cursor;
    } finally {
      old.close();
    }

    for (let boot = 0; boot < 2; boot++) {
      const { db, close } = await openDatabase(url, { migrationsFolder: MIGRATIONS_DIR });
      try {
        const { fetch } = fakeFetch((target) => {
          if (target.href !== feedUrl) return new Response(null, { status: 404 });
          return new Response(`<?xml version="1.0"?>
            <rss version="2.0"><channel><title>News</title><item>
            <guid>new</guid><title>移行後の記事</title><link>https://example.com/new</link>
            </item></channel></rss>`);
        });
        const { platform } = createTestPlatform({ db, fetch, now: () => now });
        const columns = await db.all<{ name: string }>(sql`pragma table_info(articles)`);
        const indexes = await db.all<{ name: string }>(sql`pragma index_list(articles)`);
        expect(columns.map(({ name }) => name)).not.toContain("item_id");
        expect(indexes.map(({ name }) => name)).not.toContain("articles_item_id_idx");
        expect(await db.all(sql`pragma foreign_key_check`)).toEqual([]);

        if (boot === 0) {
          expect(await runFetchFeed(platform, feedId)).toMatchObject({ status: "fetched" });
        }
        const oldArticle = {
          id: articleId,
          feedId,
          title: "移行前の記事",
          readAt: now.toISOString(),
          starredAt: now.toISOString(),
        };
        const newArticle = { feedId, title: "移行後の記事" };
        const articles = await requestApp(platform, "/api/v1/articles", { token });
        expect(articles.status).toBe(200);
        expect(await articles.json()).toMatchObject({
          items: expect.arrayContaining([
            expect.objectContaining(oldArticle),
            expect.objectContaining(newArticle),
          ]),
        });
        const sync = await requestApp(platform, "/api/v1/sync", { token });
        expect(sync.status).toBe(200);
        expect(await sync.json()).toMatchObject({
          feeds: [expect.objectContaining({ id: feedId, deleted: false })],
          articles: expect.arrayContaining([
            expect.objectContaining(oldArticle),
            expect.objectContaining(newArticle),
          ]),
        });
        const delta = await requestApp(
          platform,
          `/api/v1/sync?cursor=${encodeURIComponent(cursor)}`,
          {
            token,
          },
        );
        expect(delta.status).toBe(200);
        expect(await delta.json()).toMatchObject({
          articles: [expect.objectContaining(newArticle)],
        });
      } finally {
        close();
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
