import { expect, it } from "vitest";
import { decodeSyncCursor } from "../../src/api/sync";
import { getSubscription, unsubscribe, updateSubscription } from "../../src/db/subscriptions";
import { createWorkspace, deleteWorkspace, listWorkspaces } from "../../src/db/workspaces";
import { testDb } from "../db";
import { createTestPlatform, createUser, requestApp, subscribeFeed } from "../helpers";

type Workspace = { id: string; deleted: true } | { id: string; name: string; deleted: false };
type SyncPage = {
  cursor: string;
  hasMore: boolean;
  folders: unknown[];
  articles: unknown[];
  feeds: Array<{
    id: string;
    deleted: boolean;
    workspaceId?: string | null;
    subscriptionId?: string;
  }>;
  workspaces?: Workspace[];
};

async function setup() {
  const { platform } = createTestPlatform();
  const user = await createUser();
  const sync = async (cursor?: string, include = true) => {
    const query = new URLSearchParams();
    if (cursor !== undefined) query.set("cursor", cursor);
    if (include) query.set("includeWorkspaces", "true");
    const response = await requestApp(platform, `/api/v1/sync?${query}`, { token: user.token });
    expect(response.status).toBe(200);
    return (await response.json()) as SyncPage;
  };
  const create = async (name: string) => {
    const result = await createWorkspace(platform.db, {
      userId: user.id,
      id: crypto.randomUUID(),
      name,
      now: platform.now(),
    });
    if (typeof result === "string") throw new Error(result);
    return result.workspace;
  };
  const [initial] = await listWorkspaces(platform.db, user.id);
  if (!initial) throw new Error("default workspace is missing");
  return { platform, sync, create, initial, user };
}

it("初回・既存カーソルの同期で所属を返し、指定のない従来の同期は同じ形を保つ", async () => {
  const { initial, sync, platform, user } = await setup();
  const other = await createUser();
  const feed = await subscribeFeed(platform, { userId: user.id, url: "https://github.blog/feed/" });
  const subscription = await updateSubscription(platform.db, {
    userId: user.id,
    feedId: feed.id,
    workspaceId: initial.id,
  });
  expect(subscription).toBeDefined();
  const legacy = await sync(undefined, false);
  expect(legacy.workspaces).toBeUndefined();
  expect(legacy.feeds[0]).not.toHaveProperty("workspaceId");
  expect(legacy.feeds[0]).not.toHaveProperty("subscriptionId");

  for (const cursor of [undefined, legacy.cursor]) {
    const page = await sync(cursor);
    expect(page.workspaces).toEqual([
      { id: initial.id, name: "default", createdAt: expect.any(String), deleted: false },
    ]);
    expect(page.feeds).toMatchObject([
      {
        id: feed.id,
        workspaceId: initial.id,
        subscriptionId: subscription?.id,
        deleted: false,
      },
    ]);
    expect(page.hasMore).toBe(false);
  }
  expect(
    (await listWorkspaces(platform.db, other.id)).map((workspace) => workspace.id),
  ).not.toContain(initial.id);
});

it("差分や指定を戻したときに削除の印と購読の移動が届く", async () => {
  const { initial, sync, platform, user, create } = await setup();
  const feed = await subscribeFeed(platform, { userId: user.id });
  const before = await sync();
  const next = await create("Personal");
  await updateSubscription(platform.db, { userId: user.id, feedId: feed.id, workspaceId: next.id });
  expect(
    await deleteWorkspace(platform.db, {
      userId: user.id,
      id: initial.id,
      now: platform.now(),
    }),
  ).toBe("deleted");
  const expected = [
    { id: next.id, name: "Personal", createdAt: expect.any(String), deleted: false },
    { id: initial.id, deleted: true },
  ];
  const delta = await sync(before.cursor);
  expect(delta.workspaces).toEqual(expected);
  expect(delta.feeds).toMatchObject([{ id: feed.id, workspaceId: next.id }]);
  expect(delta.articles).toEqual([]);

  const optedOut = await sync(delta.cursor, false);
  expect(decodeSyncCursor(optedOut.cursor)?.workspaces).toBeUndefined();
  const restored = await sync(optedOut.cursor);
  expect(restored.workspaces).toEqual(expected);
  expect(restored.feeds).toMatchObject([{ id: feed.id, workspaceId: next.id }]);
  expect(restored.folders).toEqual([]);
  expect(restored.articles).toEqual([]);
  const done = await sync(restored.cursor);
  expect(done.workspaces).toEqual([]);
  expect(done.feeds).toEqual([]);
});

it("旧カーソルから購読を再送するとき、購読し直したフィードの古い削除印を返さない", async () => {
  const { sync, platform, user } = await setup();
  const reopened = await subscribeFeed(platform, {
    userId: user.id,
    url: "https://github.blog/feed/",
  });
  const removed = await subscribeFeed(platform, {
    userId: user.id,
    url: "https://www.w3.org/blog/feed/",
  });
  const legacy = await sync(undefined, false);
  for (const feed of [reopened, removed]) {
    await unsubscribe(platform.db, { userId: user.id, feedId: feed.id, now: platform.now() });
  }
  await subscribeFeed(platform, { userId: user.id, url: reopened.url });
  const current = await getSubscription(platform.db, { userId: user.id, feedId: reopened.id });
  if (!current) throw new Error("subscription missing");

  const legacyDelta = await sync(legacy.cursor, false);
  expect(legacyDelta.hasMore).toBe(false);
  const page = await sync(legacyDelta.cursor);
  expect(page.feeds).toHaveLength(2);
  expect(page.feeds).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: reopened.id, deleted: false, subscriptionId: current.id }),
      expect.objectContaining({ id: removed.id, deleted: true }),
    ]),
  );
  expect(page.folders).toEqual([]);
  expect(page.articles).toEqual([]);
});

it("同じ変更番号で複数ページに分かれても最後まで届ける", async () => {
  const { sync, user } = await setup();
  const legacy = await sync(undefined, false);
  await testDb
    .prepare(`
    WITH RECURSIVE numbers(n) AS (
      SELECT 1 UNION ALL SELECT n + 1 FROM numbers WHERE n < 501
    )
    INSERT INTO workspaces (id, user_id, name, created_at, seq)
    SELECT printf('group-%04d', n), ?, printf('Group %04d', n), 0, 1000 FROM numbers
  `)
    .bind(user.id)
    .run();

  const first = await sync(legacy.cursor);
  expect(first.hasMore).toBe(true);
  expect(first.workspaces).toHaveLength(500);
  const last = await sync(first.cursor);
  expect(last.hasMore).toBe(false);
  expect(last.workspaces?.map((workspace) => workspace.id)).toEqual(["group-0500", "group-0501"]);
});
