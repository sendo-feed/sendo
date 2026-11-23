import { type Client, createClient } from "@libsql/client";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { describe, expect, it } from "vitest";
import { MIGRATIONS_DIR } from "../db";

/*
 * 訳したときの条件を足すマイグレーション（migrations/0058、0059、docs/decisions/translation.md の 18）。
 * この決まりより前に訳した行は思考量を low にし、ほかの条件は空のままにする。条件の列は 1 行の見積もり
 * （512 バイト）の中に含め、使用量には足さない（retention.md の 2）。
 */
describe("訳したときの条件を足すマイグレーション", () => {
  /** 条件を足す前まで当て、残りのマイグレーションを返す */
  async function migrateBefore(client: Client) {
    await client.execute("PRAGMA foreign_keys = ON");
    const migrations = readMigrationFiles({ migrationsFolder: MIGRATIONS_DIR });
    const index = migrations.findIndex((m) => m.sql.some((s) => s.includes("ADD `effort`")));
    expect(index).toBeGreaterThan(0);
    for (const migration of migrations.slice(0, index)) {
      for (const statement of migration.sql) await client.execute(statement);
    }
    return migrations.slice(index);
  }

  const usage = async (client: Client) =>
    Number((await client.execute("SELECT bytes FROM storage_usage WHERE id = 1")).rows[0]?.bytes);

  const seqOf = async (client: Client, id: string) =>
    Number(
      (
        await client.execute({
          sql: "SELECT seq FROM user_articles WHERE article_id = ?",
          args: [id],
        })
      ).rows[0]?.seq,
    );

  it("前に訳した行は思考量が low になり、ほかの条件は空のまま。訳していない行は変えず、受信箱の番号も使用量も変えない。行を消すと、足した分だけ引く", async () => {
    const client = createClient({ url: ":memory:" });
    try {
      const rest = await migrateBefore(client);
      await client.execute(
        "INSERT INTO users (id, email, created_at) VALUES ('u', 'u@example.com', 0)",
      );
      await client.execute(
        "INSERT INTO feeds (id, url, created_at, next_fetch_at) VALUES ('f', 'https://example.com/feed', 0, 0)",
      );
      const ids = ["translated", "queued", "untranslated"];
      for (const [i, id] of ids.entries()) {
        await client.execute({
          sql: "INSERT INTO articles (id, feed_id, guid, item_id, published_at, created_at) VALUES (?, 'f', ?, ?, 0, 0)",
          args: [id, id, i + 1],
        });
        await client.execute({
          sql: "INSERT INTO user_articles (user_id, article_id, feed_id, published_at, created_at, seq, read_seq) VALUES ('u', ?, 'f', 0, 0, ?, ?)",
          args: [id, i + 1, i + 1],
        });
      }
      const empty = await usage(client);
      await client.execute(
        "INSERT INTO article_translations (article_id, status, language, decided_at, title, summary, model, translated_at) VALUES ('translated', 'translated', 'en', 0, '訳したタイトル', '訳した要約', 'claude-sonnet-4-6', 1)",
      );
      for (const status of ["queued", "untranslated"]) {
        await client.execute({
          sql: "INSERT INTO article_translations (article_id, status, language, decided_at) VALUES (?, ?, 'en', 0)",
          args: [status, status],
        });
      }
      const before = await usage(client);
      const seqs = Object.fromEntries(
        await Promise.all(ids.map(async (id) => [id, await seqOf(client, id)] as const)),
      );

      for (const migration of rest) {
        for (const statement of migration.sql) await client.execute(statement);
      }

      const rows = await client.execute(
        `SELECT article_id, effort, tier, prompt_version, input_tokens, output_tokens, call_model,
          title_copied_from, summary_copied_from, content_copied_from,
          batch_tier, batch_effort, batch_prompt_version
        FROM article_translations ORDER BY article_id`,
      );
      const byId = Object.fromEntries(rows.rows.map((r) => [String(r.article_id), { ...r }]));
      const others = {
        tier: null,
        prompt_version: null,
        input_tokens: null,
        output_tokens: null,
        call_model: null,
        title_copied_from: null,
        summary_copied_from: null,
        content_copied_from: null,
        batch_tier: null,
        batch_effort: null,
        batch_prompt_version: null,
      };
      expect(byId.translated).toMatchObject({ effort: "low", ...others });
      expect(byId.queued).toMatchObject({ effort: null, ...others });
      expect(byId.untranslated).toMatchObject({ effort: null, ...others });

      // 配らない条件だけが変わったので、受信箱の番号は進めない
      for (const id of ids) expect(await seqOf(client, id)).toBe(seqs[id]);

      // 思考量は 1 行の見積もりの中なので、使用量は変えない。行を消すと、足した分だけ引いて元に戻る
      expect(await usage(client)).toBe(before);
      await client.execute("DELETE FROM article_translations");
      expect(await usage(client)).toBe(empty);
    } finally {
      client.close();
    }
  });

  it("条件の列だけが変わっても受信箱の番号は進めず、使用量も変えない（1 行の見積もりの中）", async () => {
    const client = createClient({ url: ":memory:" });
    try {
      const rest = await migrateBefore(client);
      for (const migration of rest) {
        for (const statement of migration.sql) await client.execute(statement);
      }
      await client.execute(
        "INSERT INTO users (id, email, created_at) VALUES ('u', 'u@example.com', 0)",
      );
      await client.execute(
        "INSERT INTO feeds (id, url, created_at, next_fetch_at) VALUES ('f', 'https://example.com/feed', 0, 0)",
      );
      await client.execute(
        "INSERT INTO articles (id, feed_id, guid, item_id, published_at, created_at) VALUES ('a', 'f', 'a', 1, 0, 0)",
      );
      await client.execute(
        "INSERT INTO user_articles (user_id, article_id, feed_id, published_at, created_at, seq, read_seq) VALUES ('u', 'a', 'f', 0, 0, 1, 1)",
      );
      await client.execute(
        "INSERT INTO article_translations (article_id, status, language, decided_at) VALUES ('a', 'queued', 'en', 0)",
      );
      const seq = await seqOf(client, "a");
      const before = await usage(client);

      // バッチで送った条件（1 行の見積もりの中）を書いても、容量も番号も変わらない
      await client.execute(
        "UPDATE article_translations SET batch_tier = 'long', batch_effort = 'low', batch_prompt_version = 1 WHERE article_id = 'a'",
      );
      expect(await usage(client)).toBe(before);
      expect(await seqOf(client, "a")).toBe(seq);

      // 訳したときの条件だけを書いても、番号は進めず、使用量も変えない
      await client.execute(
        `UPDATE article_translations SET effort = 'medium', tier = 'normal', prompt_version = 1,
          input_tokens = 10, output_tokens = 20, call_model = 'claude-sonnet-5-5',
          title_copied_from = 'b', summary_copied_from = 'cc', content_copied_from = 'ddd'
        WHERE article_id = 'a'`,
      );
      expect(await seqOf(client, "a")).toBe(seq);
      expect(await usage(client)).toBe(before);

      // 使用量が上限ちょうどでも、条件の列は書ける（容量のトリガーは見ない）
      await client.execute("UPDATE storage_usage SET limit_bytes = bytes WHERE id = 1");
      await client.execute(
        "UPDATE article_translations SET call_model = 'claude-sonnet-5-5-longer' WHERE article_id = 'a'",
      );
      const row = (
        await client.execute("SELECT call_model FROM article_translations WHERE article_id = 'a'")
      ).rows[0];
      expect(row?.call_model).toBe("claude-sonnet-5-5-longer");
      expect(await usage(client)).toBe(before);

      // 配る項目（訳したタイトル）が変われば、番号を進める
      await client.execute("UPDATE storage_usage SET limit_bytes = bytes + 1000 WHERE id = 1");
      await client.execute("UPDATE article_translations SET title = '訳' WHERE article_id = 'a'");
      expect(await seqOf(client, "a")).toBeGreaterThan(seq);
    } finally {
      client.close();
    }
  });
});
