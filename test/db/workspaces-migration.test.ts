import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { expect, it } from "vitest";
import { encodeSyncCursor } from "../../src/api/sync";
import { INITIAL_CURSOR } from "../../src/db/sync";
import { createAccessToken } from "../../src/db/tokens";
import { openDatabase } from "../../src/platform/node/database";
import { MIGRATIONS_DIR } from "../db";
import { createTestPlatform, requestApp } from "../helpers";

async function migrationsBefore(directory: string, tagSuffix: string) {
  const oldMigrations = path.join(directory, "migrations");
  const oldMeta = path.join(oldMigrations, "meta");
  await mkdir(oldMeta, { recursive: true });
  const journal = JSON.parse(
    await readFile(path.join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8"),
  ) as { entries: { tag: string }[] };
  const index = journal.entries.findIndex(({ tag }) => tag.endsWith(tagSuffix));
  expect(index).toBeGreaterThan(0);
  const entries = journal.entries.slice(0, index);
  await writeFile(path.join(oldMeta, "_journal.json"), JSON.stringify({ ...journal, entries }));
  for (const { tag } of entries) {
    const filename = `${tag}.sql`;
    await symlink(path.join(MIGRATIONS_DIR, filename), path.join(oldMigrations, filename));
  }
  return oldMigrations;
}

it("起動時のマイグレーションは、有効な既存購読だけに default と新しい変更番号を付ける", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "sendo-workspaces-"));
  try {
    const url = `file:${path.join(directory, "sendo.db")}`;
    const old = await openDatabase(url, {
      migrationsFolder: await migrationsBefore(directory, "_workspaces"),
    });
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

it("デフォルトの移行は初回作成分を優先し、失われていれば残りか新規の1件を選ぶ", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "sendo-workspace-default-"));
  try {
    const url = `file:${path.join(directory, "sendo.db")}`;
    const old = await openDatabase(url, {
      migrationsFolder: await migrationsBefore(directory, "_workspace-default"),
    });
    const first = "00000000-0000-0000-0000-000000000001";
    const second = "00000000-0000-0000-0000-000000000002";
    let token: string;
    try {
      await old.db.run(sql`insert into users (id, email, created_at) values
        ('alice', 'alice@example.com', 9), ('bob', 'bob@example.com', 10),
        ('claire', 'claire@example.com', 11)`);
      await old.db.run(
        sql`update workspaces set name = 'Reading', seq = 20 where user_id = 'alice'`,
      );
      await old.db.run(
        sql`update workspaces set deleted_at = 21 where user_id in ('bob', 'claire')`,
      );
      await old.db.run(sql`insert into workspaces (id, user_id, name, created_at, seq) values
        ('00000000-0000-0000-0000-000000000003', 'alice', 'default', 1, 19),
        (${second}, 'bob', 'Personal', 12, 22),
        (${first}, 'bob', 'News', 12, 23)`);
      await old.db.run(sql`insert into seq_floors (table_name, floor) values ('workspaces', 25)`);
      await old.db.run(sql`insert into feeds (id, url, created_at, next_fetch_at)
        values ('feed', 'https://github.blog/feed/', 1, 1)`);
      await old.db.run(sql`insert into subscriptions
        (id, user_id, feed_id, created_at, seq, workspace_id)
        values ('unassigned', 'claire', 'feed', 11, 30, null),
        ('assigned', 'bob', 'feed', 12, 31, ${second})`);
      ({ token } = await createAccessToken(old.db, {
        userId: "alice",
        name: "Reader",
        now: new Date(),
      }));
    } finally {
      old.close();
    }

    for (let boot = 0; boot < 2; boot++) {
      const { db, close } = await openDatabase(url, { migrationsFolder: MIGRATIONS_DIR });
      try {
        const defaults = await db.all(sql`
          select user_id, name, seq from workspaces
          where deleted_at is null and is_default = 1 order by user_id
        `);
        expect(defaults).toEqual([
          { user_id: "alice", name: "Reading", seq: 26 },
          { user_id: "bob", name: "News", seq: 26 },
          { user_id: "claire", name: "default", seq: 27 },
        ]);
        const subscriptions = await db.all(sql`
          select id, workspace_id, seq from subscriptions order by id
        `);
        expect(subscriptions).toEqual([
          { id: "assigned", workspace_id: second, seq: 31 },
          { id: "unassigned", workspace_id: null, seq: 30 },
        ]);
        const { platform } = createTestPlatform({ db });
        const cursor = encodeSyncCursor({
          ...INITIAL_CURSOR,
          workspaces: { seq: 20, id: null, upTo: null, done: true },
        });
        const response = await requestApp(
          platform,
          `/api/v1/sync?includeWorkspaces=true&cursor=${cursor}`,
          {
            token,
          },
        );
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          workspaces: [{ name: "Reading", isDefault: true, deleted: false }],
        });
      } finally {
        close();
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
