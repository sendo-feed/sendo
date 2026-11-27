import { expect, it } from "vitest";
import { decodeSyncCursor } from "../../src/api/sync";
import { testDb } from "../db";
import { createTestPlatform, createUser, fakeFetch, requestApp } from "../helpers";

const rss = `<rss version="2.0"><channel><title>Blog</title>
<link>https://example.com/</link><item><title>Post</title></item></channel></rss>`;

type ActiveWorkspace = { id: string; name: string; isDefault: boolean };
type Feed = { id: string; subscriptionId: string; url: string };
type Workspace = { id: string; deleted: true } | (ActiveWorkspace & { deleted: false });
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
  defaultWorkspaceOnSubscribe?: true;
};

async function setup() {
  const { fetch } = fakeFetch(() => new Response(rss));
  const { platform } = createTestPlatform({ fetch });
  const user = await createUser();
  const request = (path: string, method = "GET", json?: unknown, token = user.token) =>
    requestApp(platform, `/api/v1${path}`, { method, json, token });
  const sync = async (cursor?: string, include = true) => {
    const query = new URLSearchParams();
    if (cursor !== undefined) query.set("cursor", cursor);
    if (include) query.set("includeWorkspaces", "true");
    const response = await request(`/sync?${query}`);
    expect(response.status).toBe(200);
    return (await response.json()) as SyncPage;
  };
  const list = async (token = user.token) => {
    const response = await request("/workspaces", "GET", undefined, token);
    expect(response.status).toBe(200);
    return ((await response.json()) as { items: ActiveWorkspace[] }).items;
  };
  const create = async (name: string) => {
    const response = await request("/workspaces", "POST", { name });
    expect(response.status).toBe(201);
    return ((await response.json()) as { workspace: ActiveWorkspace }).workspace;
  };
  const subscribe = async (url: string) => {
    const response = await request("/feeds", "POST", { url });
    expect(response.status).toBe(201);
    return ((await response.json()) as { feed: Feed }).feed;
  };
  const move = async (feed: Feed, workspaceId: string) => {
    const response = await request(`/feeds/${feed.id}`, "PATCH", {
      subscriptionId: feed.subscriptionId,
      workspaceId,
    });
    expect(response.status).toBe(200);
  };
  const [initial] = await list();
  if (!initial) throw new Error("default workspace is missing");
  return { sync, list, create, subscribe, move, request, initial, user };
}

it("初回・既存カーソルの同期で所属を返し、指定のない従来の同期は同じ形を保つ", async () => {
  const { initial, sync, list, subscribe, move } = await setup();
  const other = await createUser();
  const feed = await subscribe("https://github.blog/feed/");
  await move(feed, initial.id);
  const legacy = await sync(undefined, false);
  expect(legacy.workspaces).toBeUndefined();
  expect(legacy.defaultWorkspaceOnSubscribe).toBeUndefined();
  expect(legacy.feeds[0]).not.toHaveProperty("workspaceId");
  expect(legacy.feeds[0]).not.toHaveProperty("subscriptionId");

  for (const cursor of [undefined, legacy.cursor]) {
    const page = await sync(cursor);
    expect(page.defaultWorkspaceOnSubscribe).toBe(true);
    expect(page.workspaces).toEqual([
      {
        id: initial.id,
        name: "default",
        createdAt: expect.any(String),
        isDefault: true,
        deleted: false,
      },
    ]);
    expect(page.feeds).toMatchObject([
      {
        id: feed.id,
        workspaceId: initial.id,
        subscriptionId: feed.subscriptionId,
        deleted: false,
      },
    ]);
    expect(page.hasMore).toBe(false);
  }
  expect((await list(other.token)).map((workspace) => workspace.id)).not.toContain(initial.id);
});

it("差分や指定を戻したときに削除の印と購読の移動が届く", async () => {
  const { initial, sync, subscribe, move, request, create } = await setup();
  const feed = await subscribe("https://github.blog/feed/");
  const before = await sync();
  const next = await create("Personal");
  await move(feed, next.id);
  expect((await request(`/workspaces/${next.id}`, "PATCH", { isDefault: true })).status).toBe(200);
  expect((await request(`/workspaces/${initial.id}`, "DELETE")).status).toBe(204);
  const expected = [
    {
      id: next.id,
      name: "Personal",
      createdAt: expect.any(String),
      isDefault: true,
      deleted: false,
    },
    { id: initial.id, deleted: true },
  ];
  const delta = await sync(before.cursor);
  expect(delta.workspaces).toEqual(expected);
  expect(delta.feeds).toMatchObject([{ id: feed.id, workspaceId: next.id }]);
  expect(delta.articles).toEqual([]);

  expect((await request(`/workspaces/${next.id}`, "PATCH", { name: "Reading" })).status).toBe(200);
  const renamed = await sync(delta.cursor);
  const current = {
    id: next.id,
    name: "Reading",
    createdAt: expect.any(String),
    isDefault: true,
    deleted: false,
  };
  expect(renamed.workspaces).toEqual([current]);
  expect(renamed.feeds).toEqual([]);

  const optedOut = await sync(renamed.cursor, false);
  expect(decodeSyncCursor(optedOut.cursor)?.workspaces).toBeUndefined();
  const restored = await sync(optedOut.cursor);
  expect(restored.workspaces).toContainEqual(current);
  expect(restored.workspaces).toContainEqual({ id: initial.id, deleted: true });
  expect(restored.feeds).toMatchObject([{ id: feed.id, workspaceId: next.id }]);
  expect(restored.folders).toEqual([]);
  expect(restored.articles).toEqual([]);
  const done = await sync(restored.cursor);
  expect(done.workspaces).toEqual([]);
  expect(done.defaultWorkspaceOnSubscribe).toBe(true);
  expect(done.feeds).toEqual([]);
});

it("デフォルトの切り替えの両方の印をページをまたいで届け、再送で差分を増やさない", async () => {
  const { create, initial, request, sync, user } = await setup();
  const next = await create("Personal");
  const before = await sync();
  const position = decodeSyncCursor(before.cursor)?.workspaces;
  if (!position) throw new Error("workspace position is missing");
  // 先行する499件に旧・新デフォルトの2件を続け、500件の境界をまたぐ。
  await testDb
    .prepare(`
    WITH RECURSIVE numbers(n) AS (
      SELECT 1 UNION ALL SELECT n + 1 FROM numbers WHERE n < 499
    )
    INSERT INTO workspaces (id, user_id, name, created_at, seq)
    SELECT printf('ahead-%04d', n), ?, printf('Group %04d', n), 0, ? FROM numbers
  `)
    .bind(user.id, position.seq + 1)
    .run();
  const setDefault = () => request(`/workspaces/${next.id}`, "PATCH", { isDefault: true });
  expect((await setDefault()).status).toBe(200);
  const first = await sync(before.cursor);
  expect(first.hasMore).toBe(true);
  expect(first.workspaces).toHaveLength(500);
  const second = await sync(first.cursor);
  expect(second.hasMore).toBe(false);
  expect(second.workspaces).toHaveLength(1);
  expect([first.workspaces?.at(-1), second.workspaces?.[0]]).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: initial.id, deleted: false, isDefault: false }),
      expect.objectContaining({ id: next.id, deleted: false, isDefault: true }),
    ]),
  );
  expect((await setDefault()).status).toBe(200);
  expect((await sync(second.cursor)).workspaces).toEqual([]);
});

it("旧カーソルから購読を再送するとき、購読し直したフィードの古い削除印を返さない", async () => {
  const { sync, subscribe, request } = await setup();
  const reopened = await subscribe("https://github.blog/feed/");
  const removed = await subscribe("https://www.w3.org/blog/feed/");
  const legacy = await sync(undefined, false);
  for (const feed of [reopened, removed]) {
    expect((await request(`/feeds/${feed.id}`, "DELETE")).status).toBe(204);
  }
  const current = await subscribe(reopened.url);
  expect(current.subscriptionId).not.toBe(reopened.subscriptionId);

  const legacyDelta = await sync(legacy.cursor, false);
  expect(legacyDelta.hasMore).toBe(false);
  const page = await sync(legacyDelta.cursor);
  expect(page.feeds).toHaveLength(2);
  expect(page.feeds).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: reopened.id,
        deleted: false,
        subscriptionId: current.subscriptionId,
      }),
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
