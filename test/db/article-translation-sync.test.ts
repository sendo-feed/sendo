import { createClient } from "@libsql/client";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { describe, expect, it } from "vitest";
import { MIGRATIONS_DIR } from "../db";

/*
 * 訳文の表のトリガーを足すマイグレーション（migrations/0046_article-translation-sync.sql、
 * docs/decisions/sync.md の 10）。トリガーより前に作った訳文の行も、同期済みのクライアントに届くよう、
 * マイグレーションで受信箱の番号を一度振り直す。
 */
describe("訳文を差分同期で配るマイグレーション", () => {
  it("前からある配る訳文の行の記事だけ、受信箱の番号を進め、既読と既読の番号は変えない", async () => {
    const client = createClient({ url: ":memory:" });
    try {
      await client.execute("PRAGMA foreign_keys = ON");
      const migrations = readMigrationFiles({ migrationsFolder: MIGRATIONS_DIR });
      const index = migrations.findIndex((m) =>
        m.sql.some((s) => s.includes("article_translations_sync_insert")),
      );
      expect(index).toBeGreaterThan(0);
      for (const migration of migrations.slice(0, index)) {
        for (const statement of migration.sql) await client.execute(statement);
      }

      // トリガーより前の状態：queued と translated と skipped の訳文の行、行のない記事
      await client.execute(
        "INSERT INTO users (id, email, created_at) VALUES ('u', 'u@example.com', 0)",
      );
      await client.execute(
        "INSERT INTO feeds (id, url, created_at, next_fetch_at) VALUES ('f', 'https://example.com/feed', 0, 0)",
      );
      const ids = ["queued", "translated", "skipped", "none"];
      for (const [i, id] of ids.entries()) {
        await client.execute({
          sql: "INSERT INTO articles (id, feed_id, guid, item_id, published_at, created_at) VALUES (?, 'f', ?, ?, 0, 0)",
          args: [id, id, i + 1],
        });
        await client.execute({
          sql: "INSERT INTO user_articles (user_id, article_id, feed_id, published_at, created_at, seq, read_seq, read_at) VALUES ('u', ?, 'f', 0, 0, ?, ?, ?)",
          args: [id, i + 1, i + 1, id === "translated" ? 5 : null],
        });
      }
      for (const status of ["queued", "translated", "skipped"]) {
        await client.execute({
          sql: "INSERT INTO article_translations (article_id, status, language, decided_at) VALUES (?, ?, ?, 0)",
          args: [status, status, status === "skipped" ? "ja" : "en"],
        });
      }

      for (const migration of migrations.slice(index)) {
        for (const statement of migration.sql) await client.execute(statement);
      }
      const rows = await client.execute(
        "SELECT article_id, seq, read_seq, read_at FROM user_articles ORDER BY article_id",
      );
      const byId = Object.fromEntries(
        rows.rows.map((r) => [
          String(r.article_id),
          { seq: Number(r.seq), readSeq: Number(r.read_seq), readAt: r.read_at },
        ]),
      );
      // 届ける記事は、それまでの最大（4）より後の番号になる
      expect(byId.queued?.seq).toBeGreaterThan(4);
      expect(byId.translated?.seq).toBeGreaterThan(4);
      // skipped と行のない記事は変えない
      expect(byId.skipped?.seq).toBe(3);
      expect(byId.none?.seq).toBe(4);
      // 既読と既読の番号は変えない
      expect(byId.translated).toMatchObject({ readSeq: 2, readAt: 5 });
      expect(byId.queued?.readSeq).toBe(1);
    } finally {
      client.close();
    }
  });
});
