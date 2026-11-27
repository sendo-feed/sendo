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

  it("訳せなかった理由の列は足すだけで、前からある untranslated の行は空のまま。理由が変わると番号を振る", async () => {
    const client = createClient({ url: ":memory:" });
    try {
      await client.execute("PRAGMA foreign_keys = ON");
      const migrations = readMigrationFiles({ migrationsFolder: MIGRATIONS_DIR });
      const index = migrations.findIndex((m) =>
        m.sql.some((s) => s.includes("ADD `failure_kind`")),
      );
      expect(index).toBeGreaterThan(0);
      for (const migration of migrations.slice(0, index)) {
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
        "INSERT INTO article_translations (article_id, status, language, decided_at) VALUES ('a', 'untranslated', 'en', 0)",
      );
      const seqBefore = Number(
        (await client.execute("SELECT seq FROM user_articles WHERE article_id = 'a'")).rows[0]?.seq,
      );

      for (const migration of migrations.slice(index)) {
        for (const statement of migration.sql) await client.execute(statement);
      }
      const row = (
        await client.execute(
          "SELECT failure_kind, failure_category, failure_stage FROM article_translations WHERE article_id = 'a'",
        )
      ).rows[0];
      expect(row).toMatchObject({
        failure_kind: null,
        failure_category: null,
        failure_stage: null,
      });
      const seq = async () =>
        Number(
          (await client.execute("SELECT seq FROM user_articles WHERE article_id = 'a'")).rows[0]
            ?.seq,
        );
      // 列を足すだけでは番号を振らない
      expect(await seq()).toBe(seqBefore);
      // 状態が同じでも、理由だけが変わったら番号を振る
      await client.execute(
        "UPDATE article_translations SET failure_kind = 'refused', failure_category = 'cyber', failure_stage = 'batch' WHERE article_id = 'a'",
      );
      const afterSet = await seq();
      expect(afterSet).toBeGreaterThan(seqBefore);
      await client.execute(
        "UPDATE article_translations SET failure_category = 'bio' WHERE article_id = 'a'",
      );
      expect(await seq()).toBeGreaterThan(afterSet);
    } finally {
      client.close();
    }
  });

  it("モデルと思考量を配るトリガーに作り直しても、前からある行の番号は振り直さない。モデルか思考量が変わると振り、配らない条件や skipped の行では振らない", async () => {
    const client = createClient({ url: ":memory:" });
    try {
      await client.execute("PRAGMA foreign_keys = ON");
      const migrations = readMigrationFiles({ migrationsFolder: MIGRATIONS_DIR });
      const index = migrations.findIndex((m) =>
        m.sql.some((s) => s.includes("OLD.effort IS NOT NEW.effort")),
      );
      expect(index).toBeGreaterThan(0);
      for (const migration of migrations.slice(0, index)) {
        for (const statement of migration.sql) await client.execute(statement);
      }

      // 作り直す前の状態：訳した行（条件あり）、訳し直しの最中の行、待ちの行、skipped の行
      await client.execute(
        "INSERT INTO users (id, email, created_at) VALUES ('u', 'u@example.com', 0)",
      );
      await client.execute(
        "INSERT INTO feeds (id, url, created_at, next_fetch_at) VALUES ('f', 'https://example.com/feed', 0, 0)",
      );
      const ids = ["translated", "translating", "queued", "skipped"];
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
      for (const status of ["translated", "translating"]) {
        await client.execute({
          sql: "INSERT INTO article_translations (article_id, status, language, decided_at, title, model, effort, translated_at) VALUES (?, ?, 'en', 0, '訳', 'claude-sonnet-5-5', 'medium', 1)",
          args: [status, status],
        });
      }
      await client.execute(
        "INSERT INTO article_translations (article_id, status, language, decided_at) VALUES ('queued', 'queued', 'en', 0)",
      );
      await client.execute(
        "INSERT INTO article_translations (article_id, status, language, decided_at) VALUES ('skipped', 'skipped', 'ja', 0)",
      );
      const seq = async (id: string) =>
        Number(
          (
            await client.execute({
              sql: "SELECT seq FROM user_articles WHERE article_id = ?",
              args: [id],
            })
          ).rows[0]?.seq,
        );
      const before = Object.fromEntries(
        await Promise.all(ids.map(async (id) => [id, await seq(id)] as const)),
      );

      for (const migration of migrations.slice(index)) {
        for (const statement of migration.sql) await client.execute(statement);
      }
      // 作り直すだけでは、どの行の番号も振り直さない
      for (const id of ids) expect(await seq(id)).toBe(before[id]);

      // モデルだけ、思考量だけが変わっても振る（null から値になるときも、値から null になるときも）
      let last = await seq("translated");
      for (const set of [
        "model = 'claude-opus-5-5'",
        "effort = 'high'",
        "effort = NULL",
        "effort = 'medium'",
      ]) {
        await client.execute(
          `UPDATE article_translations SET ${set} WHERE article_id = 'translated'`,
        );
        const next = await seq("translated");
        expect(next).toBeGreaterThan(last);
        last = next;
      }
      // 同じ値を書いても振らない
      await client.execute(
        "UPDATE article_translations SET model = 'claude-opus-5-5', effort = 'medium' WHERE article_id = 'translated'",
      );
      expect(await seq("translated")).toBe(last);

      // 配らない条件（段階、プロンプトの版、トークン数、呼び出しのモデル、写した元、バッチで送った条件）
      // だけが変わっても振らない
      for (const set of [
        "tier = 'quality'",
        "prompt_version = 2",
        "input_tokens = 10, output_tokens = 20",
        "call_model = 'claude-haiku-5-5'",
        "title_copied_from = 'a', summary_copied_from = 'b', content_copied_from = 'c'",
        "batch_tier = 'long', batch_effort = 'low', batch_prompt_version = 2",
      ]) {
        await client.execute(
          `UPDATE article_translations SET ${set} WHERE article_id IN ('translated', 'translating', 'queued')`,
        );
      }
      expect(await seq("translated")).toBe(last);
      expect(await seq("translating")).toBe(before.translating);
      expect(await seq("queued")).toBe(before.queued);

      // skipped の行は、モデルと思考量が変わっても振らない
      await client.execute(
        "UPDATE article_translations SET model = 'claude-opus-5-5', effort = 'max' WHERE article_id = 'skipped'",
      );
      expect(await seq("skipped")).toBe(before.skipped);
    } finally {
      client.close();
    }
  });
});
