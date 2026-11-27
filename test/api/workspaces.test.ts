import { expect, it } from "vitest";
import { insertArticles } from "../../src/db/articles";
import { deliverNewArticles, setArticleState } from "../../src/db/inbox";
import { getSubscription } from "../../src/db/subscriptions";
import { createTestPlatform, createUser, fakeFetch, requestApp, uniqueUrl } from "../helpers";

const rss = `<rss version="2.0"><channel><title>Blog</title>
<link>https://example.com/</link><item><title>Post</title></item></channel></rss>`;

type Workspace = { id: string; name: string; isDefault: boolean };
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

it("新規アカウントのデフォルトは改名でき、切り替えると空の旧デフォルトを削除できる", async () => {
  const { initial, list, request } = await setup();
  expect(initial.name).toBe("default");
  expect(initial.isDefault).toBe(true);
  const id = crypto.randomUUID();
  const created = await request("/workspaces", "POST", { id, name: " Personal " });
  expect(created.status).toBe(201);
  expect(await created.json()).toMatchObject({
    workspace: { id, name: "Personal", isDefault: false },
  });

  expect((await request(`/workspaces/${id}`, "PATCH", { name: "Private" })).status).toBe(200);
  const retry = await request("/workspaces", "POST", { id, name: "Personal" });
  expect(retry.status).toBe(200);
  expect(await retry.json()).toMatchObject({ workspace: { id, name: "Private" } });
  const duplicate = await request("/workspaces", "POST", { name: "Private" });
  expect(duplicate.status).toBe(409);
  expect(await duplicate.json()).toMatchObject({ error: { code: "workspace_exists" } });
  expect((await request(`/workspaces/${initial.id}`, "PATCH", { name: "News" })).status).toBe(200);
  expect(await list()).toMatchObject([
    { id: initial.id, name: "News", isDefault: true },
    { id, name: "Private", isDefault: false },
  ]);
  const blocked = await request(`/workspaces/${initial.id}`, "DELETE");
  expect(blocked.status).toBe(409);
  expect(await blocked.json()).toMatchObject({ error: { code: "workspace_is_default" } });
  for (const invalid of [{ isDefault: false }, { name: "Both", isDefault: true }, {}]) {
    expect((await request(`/workspaces/${id}`, "PATCH", invalid)).status).toBe(400);
  }
  const switched = await request(`/workspaces/${id}`, "PATCH", { isDefault: true });
  expect(switched.status).toBe(200);
  expect(await switched.json()).toMatchObject({ workspace: { id, isDefault: true } });
  expect((await request(`/workspaces/${initial.id}`, "DELETE")).status).toBe(204);
  expect((await request(`/workspaces/${initial.id}`, "DELETE")).status).toBe(204);
  expect(await list()).toMatchObject([{ id, isDefault: true }]);
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
  const alternative = await request("/workspaces", "POST", { name: "Reading" });
  const { workspace: reading } = (await alternative.json()) as { workspace: Workspace };
  expect((await request(`/workspaces/${reading.id}`, "PATCH", { isDefault: true })).status).toBe(
    200,
  );
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
  expect(
    (await owner.request(`/workspaces/${outsider.initial.id}`, "PATCH", { isDefault: true }))
      .status,
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
  expect(feed.workspaceId).toBe(owner.initial.id);

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

  const created = await owner.request("/workspaces", "POST", { name: "Temporary" });
  const { workspace } = (await created.json()) as { workspace: Workspace };
  expect((await owner.request(`/workspaces/${workspace.id}`, "DELETE")).status).toBe(204);
  expect(
    (await owner.request(`/workspaces/${workspace.id}`, "PATCH", { isDefault: true })).status,
  ).toBe(404);
  const gone = await owner.request("/feeds", "POST", {
    url: uniqueUrl(),
    workspaceId: workspace.id,
  });
  expect(gone.status).toBe(400);
  expect(await owner.list()).toMatchObject([{ id: owner.initial.id, isDefault: true }]);
});

it("購読の所属付けとワークスペースの削除が重なっても無効な所属を作らない", async () => {
  const { initial, platform, request, user } = await setup();
  const created = await request("/workspaces", "POST", { name: "Personal" });
  const { workspace } = (await created.json()) as { workspace: Workspace };
  const { feed } = (await (await request("/feeds", "POST", { url: uniqueUrl() })).json()) as {
    feed: Feed;
  };
  const [move, remove] = await Promise.all([
    request(`/feeds/${feed.id}`, "PATCH", {
      subscriptionId: feed.subscriptionId,
      workspaceId: workspace.id,
    }),
    request(`/workspaces/${workspace.id}`, "DELETE"),
  ]);
  const workspaceId = (await getSubscription(platform.db, { userId: user.id, feedId: feed.id }))
    ?.workspaceId;
  if (move.status === 200) {
    expect(remove.status).toBe(409);
    expect(workspaceId).toBe(workspace.id);
  } else {
    expect(move.status).toBe(400);
    expect(remove.status).toBe(204);
    expect(workspaceId).toBe(initial.id);
  }
});

it("REST の新規購読では省略と null がデフォルトを使い、明示先と既存の所属を保つ", async () => {
  const { initial, request } = await setup();
  const created = await request("/workspaces", "POST", { name: "Personal" });
  const { workspace } = (await created.json()) as { workspace: Workspace };
  expect((await request(`/workspaces/${workspace.id}`, "PATCH", { isDefault: true })).status).toBe(
    200,
  );
  const before = await request("/sync?includeWorkspaces=true");
  const { cursor } = (await before.json()) as { cursor: string };
  const expected = [];
  let omittedFeed: Feed | undefined;
  const omittedUrl = "https://www.apple.com/newsroom/rss-feed.rss";
  for (const [body, workspaceId] of [
    [{ url: omittedUrl }, workspace.id],
    [{ url: "https://github.blog/feed/", workspaceId: null }, workspace.id],
    [{ url: "https://www.w3.org/blog/feed/", workspaceId: initial.id }, initial.id],
  ] as const) {
    const response = await request("/feeds", "POST", body);
    expect(response.status).toBe(201);
    const { feed } = (await response.json()) as { feed: Feed };
    expect(feed.workspaceId).toBe(workspaceId);
    expected.push(expect.objectContaining({ id: feed.id, workspaceId }));
    if (body.url === omittedUrl) omittedFeed = feed;
  }
  const delta = await request(`/sync?includeWorkspaces=true&cursor=${cursor}`);
  expect(await delta.json()).toMatchObject({ feeds: expect.arrayContaining(expected) });
  if (!omittedFeed) throw new Error("subscription is missing");
  const detached = await request(`/feeds/${omittedFeed.id}`, "PATCH", {
    subscriptionId: omittedFeed.subscriptionId,
    workspaceId: null,
  });
  expect(detached.status).toBe(200);
  expect(await detached.json()).toMatchObject({ feed: { workspaceId: null } });
  const retry = await request("/feeds", "POST", { url: omittedUrl });
  expect(retry.status).toBe(200);
  expect(await retry.json()).toMatchObject({ feed: { id: omittedFeed.id, workspaceId: null } });
});

it("REST の取得中に明示先を削除すると、デフォルトへの購読は作らない", async () => {
  const { request, user } = await setup();
  const created = await request("/workspaces", "POST", { name: "Temporary" });
  const { workspace } = (await created.json()) as { workspace: Workspace };
  const { fetch } = fakeFetch(async () => {
    expect((await request(`/workspaces/${workspace.id}`, "DELETE")).status).toBe(204);
    return new Response(rss);
  });
  const { platform } = createTestPlatform({ fetch });
  const url = "https://hnrss.org/newest?q=Claude";
  const response = await requestApp(platform, "/api/v1/feeds", {
    token: user.token,
    method: "POST",
    json: { url, workspaceId: workspace.id },
  });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: { code: "workspace_not_found" } });
  expect(await (await request("/feeds")).json()).toMatchObject({ items: [] });
});

it("REST の取得中にデフォルトを切り替えると、書き込み時のデフォルトに入る", async () => {
  const { request, user } = await setup();
  const created = await request("/workspaces", "POST", { name: "Personal" });
  const { workspace } = (await created.json()) as { workspace: Workspace };
  const { fetch } = fakeFetch(async () => {
    const switched = await request(`/workspaces/${workspace.id}`, "PATCH", { isDefault: true });
    expect(switched.status).toBe(200);
    return new Response(rss);
  });
  const { platform } = createTestPlatform({ fetch });
  const response = await requestApp(platform, "/api/v1/feeds", {
    token: user.token,
    method: "POST",
    json: { url: "https://blog.cloudflare.com/rss/" },
  });
  expect(response.status).toBe(201);
  expect(await response.json()).toMatchObject({ feed: { workspaceId: workspace.id } });
});

it("デフォルトへの切り替えと削除が重なっても有効なデフォルトが1件残る", async () => {
  const { initial, list, request } = await setup();
  const created = await request("/workspaces", "POST", { name: "Personal" });
  const { workspace } = (await created.json()) as { workspace: Workspace };
  const target = `/workspaces/${workspace.id}`;
  const [switched, removed] = await Promise.all([
    request(target, "PATCH", { isDefault: true }),
    request(target, "DELETE"),
  ]);
  const defaults = (await list()).filter((item) => item.isDefault);
  if (switched.status === 200) {
    expect(removed.status).toBe(409);
    expect(await removed.json()).toMatchObject({ error: { code: "workspace_is_default" } });
    expect(defaults.map((item) => item.id)).toEqual([workspace.id]);
  } else {
    expect(switched.status).toBe(404);
    expect(removed.status).toBe(204);
    expect(defaults.map((item) => item.id)).toEqual([initial.id]);
  }
});
