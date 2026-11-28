import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { describe, expect, it } from "vitest";
import { insertArticles } from "../../../src/db/articles";
import { noteContentKeys, reserveContents } from "../../../src/db/content";
import { insertFeed } from "../../../src/db/feeds";
import * as schema from "../../../src/db/schema";
import { configureStorage, readStorageUsage } from "../../../src/db/storage";
import { createNodePlatform } from "../../../src/platform/node";
import { createSqliteJobQueue } from "../../../src/platform/node/job-queue";
import { MIGRATIONS_DIR, openTestDatabase } from "../../db";
import { inThreadHeavyRead, unusedNative, unusedSyncUpdates } from "../../helpers";

describe("保存容量", () => {
  it("環境変数を読み、SQLite でも同時の本文予約を上限内に収める", async () => {
    const database = await openTestDatabase();
    try {
      const jobs = createSqliteJobQueue(database.db);
      const platform = createNodePlatform({
        syncUpdates: unusedSyncUpdates,
        env: { DATA_DIR: database.directory, STORAGE_LIMIT_MIB: "20480" },
        db: database.db,
        heavyRead: inThreadHeavyRead(database.db),
        jobs,
        ...unusedNative,
      });
      expect(platform.retentionConfig.maxBytes).toBe(20 * 1024 ** 3);
      expect(
        createNodePlatform({
          syncUpdates: unusedSyncUpdates,
          env: {},
          db: database.db,
          heavyRead: inThreadHeavyRead(database.db),
          jobs,
          ...unusedNative,
        }).retentionConfig.maxBytes,
      ).toBe(10 * 1024 ** 3);
      const { feed } = await insertFeed(database.db, {
        id: "feed",
        url: "https://example.com/feed",
        now: new Date(),
      });
      await insertArticles(database.db, [
        { id: "article", feedId: feed.id, guid: "guid", publishedAt: new Date() },
      ]);
      const before = await readStorageUsage(database.db);
      await configureStorage(database.db, before.bytes + 1000);
      await noteContentKeys(database.db, ["feed/a", "feed/b"]);
      const results = await Promise.all([
        reserveContents(database.db, [{ key: "feed/a", bytes: 700 }]),
        reserveContents(database.db, [{ key: "feed/b", bytes: 700 }]),
      ]);
      expect(results.reduce((n, keys) => n + keys.size, 0)).toBe(1);
      expect((await readStorageUsage(database.db)).bytes).toBeLessThanOrEqual(before.bytes + 1000);
    } finally {
      await database.cleanup();
    }
  });

  it("既存のDBを移行すると、記事と抽出本文を集計し、外の本文を未集計として引き継ぐ", async () => {
    const client = createClient({ url: ":memory:" });
    try {
      await client.execute("PRAGMA foreign_keys = ON");
      const migrations = readMigrationFiles({ migrationsFolder: MIGRATIONS_DIR });
      for (const migration of migrations.slice(0, 24)) {
        for (const statement of migration.sql) await client.execute(statement);
      }
      await client.execute(
        "INSERT INTO feeds (id, url, created_at, next_fetch_at) VALUES ('legacy-feed', 'https://example.com/feed', 0, 0)",
      );
      await client.execute(
        "INSERT INTO articles (id, feed_id, guid, item_id, published_at, created_at, content_key) VALUES ('legacy', 'legacy-feed', 'guid', 1, 0, 0, 'feed/legacy')",
      );
      await client.execute(
        "INSERT INTO page_contents (article_id, status, html, attempted_at) VALUES ('legacy', 'extracted', '<p>既存本文</p>', 0)",
      );
      await client.execute("INSERT INTO content_notes (key, created_at) VALUES ('feed/orphan', 0)");
      for (const migration of migrations.slice(24)) {
        for (const statement of migration.sql) await client.execute(statement);
      }
      const db = drizzle(client, { schema });
      const usage = await readStorageUsage(db);
      expect(usage.bytes).toBeGreaterThan(2048);
      expect(usage.unmeasured).toBe(2);
      expect((await db.select().from(schema.articles))[0]).toMatchObject({
        id: "legacy",
        inCurrentFeed: true,
      });
      expect((await db.select().from(schema.pageContents))[0]?.html).toBe("<p>既存本文</p>");
    } finally {
      client.close();
    }
  });
});
