import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { expect, it } from "vitest";
import { openDatabase } from "../../src/platform/node/database";
import { MIGRATIONS_DIR } from "../db";

it("起動時のマイグレーションは、有効な既存購読だけに default と新しい変更番号を付ける", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "sendo-workspaces-"));
  try {
    const oldMigrations = path.join(directory, "migrations");
    const oldMeta = path.join(oldMigrations, "meta");
    const url = `file:${path.join(directory, "sendo.db")}`;
    await mkdir(oldMeta, { recursive: true });
    const journal = JSON.parse(
      await readFile(path.join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8"),
    ) as { entries: { tag: string }[] };
    const index = journal.entries.findIndex(({ tag }) => tag.endsWith("_workspaces"));
    expect(index).toBeGreaterThan(0);
    const entries = journal.entries.slice(0, index);
    await writeFile(path.join(oldMeta, "_journal.json"), JSON.stringify({ ...journal, entries }));
    for (const { tag } of entries) {
      const filename = `${tag}.sql`;
      await symlink(path.join(MIGRATIONS_DIR, filename), path.join(oldMigrations, filename));
    }

    const old = await openDatabase(url, { migrationsFolder: oldMigrations });
    try {
      await old.db.run(sql`insert into users (id, email, created_at) values
        ('alice', 'alice@example.com', 1), ('bob', 'bob@example.com', 2)`);
      await old.db.run(sql`insert into feeds (id, url, created_at, next_fetch_at)
        values ('feed', 'https://github.blog/feed/', 1, 1)`);
      await old.db.run(sql`insert into subscriptions (id, user_id, feed_id, created_at, seq, deleted_at)
        values ('old', 'alice', 'feed', 1, 2, 3), ('current', 'alice', 'feed', 4, 4, null)`);
      await old.db.run(sql`insert into seq_floors (table_name, floor) values ('subscriptions', 10)
        on conflict (table_name) do update set floor = excluded.floor`);
    } finally {
      old.close();
    }

    for (let boot = 0; boot < 2; boot++) {
      const { db, close } = await openDatabase(url, { migrationsFolder: MIGRATIONS_DIR });
      try {
        const groups = await db.all(sql`select user_id, name from workspaces order by user_id`);
        expect(groups).toEqual([
          { user_id: "alice", name: "default" },
          { user_id: "bob", name: "default" },
        ]);
        const subscriptions = await db.all(sql`
          select s.id, s.seq, w.user_id as owner
          from subscriptions s left join workspaces w on w.id = s.workspace_id
          order by s.id
        `);
        expect(subscriptions).toEqual([
          { id: "current", seq: 11, owner: "alice" },
          { id: "old", seq: 2, owner: null },
        ]);
      } finally {
        close();
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
