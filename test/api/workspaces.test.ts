import { expect, it } from "vitest";
import { insertArticles } from "../../src/db/articles";
import { deliverNewArticles, setArticleState } from "../../src/db/inbox";
import { getSubscription } from "../../src/db/subscriptions";
import { createTestPlatform, createUser, fakeFetch, requestApp, uniqueUrl } from "../helpers";

const rss = `<rss version="2.0"><channel><title>Blog</title>
<link>https://example.com/</link><item><title>Post</title></item></channel></rss>`;

type Workspace = { id: string; name: string };
type Feed = { id: string; subscriptionId: string; workspaceId: string | null };

async function setup() {
  const user = await createUser();
  const { fetch } = fakeFetch(() => new Response(rss));
  const { platform } = createTestPlatform({ fetch });
  const request = (path: string, method = "GET", json?: unknown) =>
    requestApp(platform, `/api/v1${path}`, { method, json, token: user.token });
  const list = async () =>
    ((await (await request("/workspaces")).json()) as { items: Workspace[] }).items;
  const [initial] = await list();
  if (!initial) throw new Error("default workspace is missing");
  return { initial, list, platform, request, user };
}

it("新規アカウントの default は改名・削除でき、同じ ID の作成を送り直せる", async () => {
  const { initial, list, request } = await setup();
  expect(initial.name).toBe("default");
  const id = crypto.randomUUID();
  const created = await request("/workspaces", "POST", { id, name: " Personal " });
  expect(created.status).toBe(201);
  expect(await created.json()).toMatchObject({ workspace: { id, name: "Personal" } });

  expect((await request(`/workspaces/${id}`, "PATCH", { name: "Private" })).status).toBe(200);
  const retry = await request("/workspaces", "POST", { id, name: "Personal" });
  expect(retry.status).toBe(200);
  expect(await retry.json()).toMatchObject({ workspace: { id, name: "Private" } });
  const duplicate = await request("/workspaces", "POST", { name: "Private" });
  expect(duplicate.status).toBe(409);
  expect(await duplicate.json()).toMatchObject({ error: { code: "workspace_exists" } });
  expect((await request(`/workspaces/${initial.id}`, "PATCH", { name: "News" })).status).toBe(200);
  expect((await list()).map((row) => row.name)).toEqual(["News", "Private"]);
  expect((await request(`/workspaces/${initial.id}`, "DELETE")).status).toBe(204);
  expect((await request(`/workspaces/${initial.id}`, "DELETE")).status).toBe(204);
  expect((await request(`/workspaces/${id}`, "DELETE")).status).toBe(204);
  expect(await list()).toEqual([]);
});

it("購読の移動は記事・既読とスターを保ち、空のワークスペースだけ削除できる", async () => {
  const { initial, request, platform, user } = await setup();
  const folderResponse = await request("/folders", "POST", { name: "Blogs" });
  const { folder } = (await folderResponse.json()) as { folder: { id: string } };
  const url = uniqueUrl();
  const added = await request("/feeds", "POST", {
    url,
    folderId: folder.id,
    workspaceId: initial.id,
  });
  expect(added.status).toBe(201);
  const { feed } = (await added.json()) as { feed: Feed };
  expect(feed.workspaceId).toBe(initial.id);
  const supplied = await request("/workspaces", "POST", { name: "Personal" });
  const { workspace } = (await supplied.json()) as { workspace: Workspace };
  const duplicate = await request("/feeds", "POST", { url, workspaceId: workspace.id });
  expect(duplicate.status).toBe(200);
  expect(await duplicate.json()).toMatchObject({ feed: { workspaceId: initial.id } });

  const now = new Date();
  const articleId = crypto.randomUUID();
  await insertArticles(platform.db, [
    {
      id: articleId,
      feedId: feed.id,
      guid: "post",
      title: "Post",
      publishedAt: now,
      createdAt: now,
    },
  ]);
  await deliverNewArticles(platform.db, { feedId: feed.id });
  await setArticleState(platform.db, {
    userId: user.id,
    articleId,
    read: true,
    starred: true,
    now,
  });
  const before = (await (await request(`/articles?feedId=${feed.id}`)).json()) as {
    items: unknown[];
  };
  expect(before).toMatchObject({
    items: [{ id: articleId, readAt: now.toISOString(), starredAt: now.toISOString() }],
  });

  const nonempty = await request(`/workspaces/${initial.id}`, "DELETE");
  expect(nonempty.status).toBe(409);
  expect(await nonempty.json()).toMatchObject({ error: { code: "workspace_not_empty" } });
  const moved = await request(`/feeds/${feed.id}`, "PATCH", {
    subscriptionId: feed.subscriptionId,
    workspaceId: workspace.id,
  });
  expect(moved.status).toBe(200);
  expect(await moved.json()).toMatchObject({
    feed: { ...feed, workspaceId: workspace.id, folderId: folder.id },
  });
  const after = (await (await request(`/articles?feedId=${feed.id}`)).json()) as {
    items: unknown[];
  };
  expect(after.items).toEqual(before.items);
  expect((await request(`/workspaces/${initial.id}`, "DELETE")).status).toBe(204);
  expect((await request(`/feeds/${feed.id}`, "DELETE")).status).toBe(204);
  expect((await request(`/workspaces/${workspace.id}`, "DELETE")).status).toBe(204);
});

it("別アカウントと削除済みのワークスペースへの書き込み、購読し直した行への再送を拒む", async () => {
  const owner = await setup();
  const outsider = await setup();
  expect(
    (await owner.request(`/workspaces/${outsider.initial.id}`, "PATCH", { name: "News" })).status,
  ).toBe(404);
  expect((await owner.request(`/workspaces/${outsider.initial.id}`, "DELETE")).status).toBe(404);
  const url = uniqueUrl();
  const otherDestination = await owner.request("/feeds", "POST", {
    url,
    workspaceId: outsider.initial.id,
  });
  expect(otherDestination.status).toBe(400);
  expect(await otherDestination.json()).toMatchObject({ error: { code: "workspace_not_found" } });

  const added = await owner.request("/feeds", "POST", { url });
  expect(added.status).toBe(201);
  const { feed } = (await added.json()) as { feed: Feed };
  expect(feed.workspaceId).toBeNull();

  const badMove = await owner.request(`/feeds/${feed.id}`, "PATCH", {
    subscriptionId: feed.subscriptionId,
    workspaceId: outsider.initial.id,
    displayName: "Unexpected",
  });
  expect(badMove.status).toBe(400);
  expect(
    (await getSubscription(owner.platform.db, { userId: owner.user.id, feedId: feed.id }))
      ?.displayName,
  ).toBeNull();

  expect((await owner.request(`/feeds/${feed.id}`, "DELETE")).status).toBe(204);
  expect((await owner.request("/feeds", "POST", { url, workspaceId: null })).status).toBe(201);
  const stale = await owner.request(`/feeds/${feed.id}`, "PATCH", {
    subscriptionId: feed.subscriptionId,
    workspaceId: owner.initial.id,
  });
  expect(stale.status).toBe(404);

  expect((await owner.request(`/workspaces/${owner.initial.id}`, "DELETE")).status).toBe(204);
  const gone = await owner.request("/feeds", "POST", {
    url: uniqueUrl(),
    workspaceId: owner.initial.id,
  });
  expect(gone.status).toBe(400);
  expect(await owner.list()).toEqual([]);
});

it("購読の所属付けとワークスペースの削除が重なっても無効な所属を作らない", async () => {
  const { initial, platform, request, user } = await setup();
  const { feed } = (await (await request("/feeds", "POST", { url: uniqueUrl() })).json()) as {
    feed: Feed;
  };
  const [move, remove] = await Promise.all([
    request(`/feeds/${feed.id}`, "PATCH", {
      subscriptionId: feed.subscriptionId,
      workspaceId: initial.id,
    }),
    request(`/workspaces/${initial.id}`, "DELETE"),
  ]);
  const workspaceId = (await getSubscription(platform.db, { userId: user.id, feedId: feed.id }))
    ?.workspaceId;
  if (move.status === 200) {
    expect(remove.status).toBe(409);
    expect(workspaceId).toBe(initial.id);
  } else {
    expect(move.status).toBe(400);
    expect(remove.status).toBe(204);
    expect(workspaceId).toBeNull();
  }
});
