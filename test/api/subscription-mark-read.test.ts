import { expect, it } from "vitest";
import { insertArticles } from "../../src/db/articles";
import { getSubscription } from "../../src/db/subscriptions";
import type { Platform } from "../../src/platform";
import { addToInbox, createTestPlatform, createUser, requestApp, subscribeFeed } from "../helpers";

async function setup() {
  const user = await createUser();
  const { platform } = createTestPlatform();
  const request = (path: string, method = "GET", json?: unknown) =>
    requestApp(platform, `/api/v1${path}`, { method, json, token: user.token });
  const cursor = async () => {
    const response = await request("/sync");
    const page = (await response.json()) as { cursor: string; hasMore: boolean };
    expect(page.hasMore).toBe(false);
    return page.cursor;
  };
  const unread = async () => {
    const response = await request("/articles?state=unread");
    const { items } = (await response.json()) as {
      items: Array<{ id: string; readAt: string | null }>;
    };
    return items
      .filter((item) => item.readAt === null)
      .map((item) => item.id)
      .sort();
  };
  const mark = (json: unknown) => request("/articles/mark-read", "POST", json);
  const addFeed = async (url: string) => {
    const feed = await subscribeFeed(platform, { userId: user.id, url });
    const row = await getSubscription(platform.db, { userId: user.id, feedId: feed.id });
    if (!row) throw new Error("subscription missing");
    return { feed, subscriptionId: row.id };
  };
  return { user, platform, cursor, unread, mark, addFeed, request };
}

async function addArticle(platform: Platform, userId: string, feedId: string, title: string) {
  const id = crypto.randomUUID();
  const now = platform.now();
  await insertArticles(platform.db, [{ id, feedId, guid: id, title, publishedAt: now }]);
  await addToInbox(platform, [
    { articleId: id, userId, feedId, publishedAt: now, receivedAt: now },
  ]);
  return id;
}

it("操作時の購読 ID の範囲と同期済みの境界を両方守る", async () => {
  const { user, platform, cursor, unread, mark, addFeed, request } = await setup();
  const publicFeed = await addFeed("https://github.blog/feed/");
  const personalFeed = await addFeed("https://www.w3.org/blog/feed/");
  const visible = await addArticle(platform, user.id, publicFeed.feed.id, "Visible");
  const personal = await addArticle(platform, user.id, personalFeed.feed.id, "Personal");
  const at = await cursor();
  const later = await addArticle(platform, user.id, publicFeed.feed.id, "Later");

  const invalid = await mark({
    subscriptionIds: [publicFeed.subscriptionId],
    all: true,
    cursor: at,
  });
  expect(invalid.status).toBe(400);
  expect((await mark({ subscriptionIds: [publicFeed.subscriptionId] })).status).toBe(400);
  expect(
    (
      await mark({
        subscriptionIds: [publicFeed.subscriptionId],
        cursor: at,
        until: platform.now().toISOString(),
      })
    ).status,
  ).toBe(400);
  expect(await unread()).toEqual([visible, personal, later].sort());

  const body = { subscriptionIds: [publicFeed.subscriptionId], cursor: at };
  const result = await mark(body);
  expect(result.status).toBe(200);
  expect(await result.json()).toEqual({ updated: 1 });
  expect(await unread()).toEqual([personal, later].sort());

  expect((await request(`/articles/${visible}`, "PATCH", { read: false })).status).toBe(200);
  expect(await (await mark(body)).json()).toEqual({ updated: 0 });
  expect(await unread()).toEqual([visible, personal, later].sort());

  const both = await mark({
    subscriptionIds: [publicFeed.subscriptionId, personalFeed.subscriptionId],
    cursor: await cursor(),
  });
  expect(await both.json()).toEqual({ updated: 3 });
  expect(await unread()).toEqual([]);
});

it("他のアカウントの購読 ID と、解除して作り直した購読の古い ID では既読にならない", async () => {
  const { user, platform, cursor, unread, mark, addFeed, request } = await setup();
  const { feed, subscriptionId } = await addFeed("https://github.blog/feed/");
  const other = await createUser();
  await subscribeFeed(platform, { userId: other.id, url: feed.url });
  const foreign = await getSubscription(platform.db, { userId: other.id, feedId: feed.id });
  if (!foreign) throw new Error("foreign subscription missing");

  const saved = await addArticle(platform, user.id, feed.id, "Saved");
  expect((await request(`/articles/${saved}`, "PATCH", { starred: true })).status).toBe(200);
  const at = await cursor();
  expect((await request(`/feeds/${feed.id}`, "DELETE")).status).toBe(204);
  expect((await request("/feeds", "POST", { url: feed.url })).status).toBe(201);
  const again = await getSubscription(platform.db, { userId: user.id, feedId: feed.id });
  expect(again).toBeDefined();
  expect(again?.id).not.toBe(subscriptionId);

  const before = await unread();
  expect(before).toContain(saved);
  const stale = await mark({ subscriptionIds: [subscriptionId, foreign.id], cursor: at });
  expect(stale.status).toBe(200);
  expect(await stale.json()).toEqual({ updated: 0 });
  expect(await unread()).toEqual(before);
});

it("購読 ID は1回に90件までで、同じカーソルで続きを送れる", async () => {
  const { user, platform, cursor, unread, mark, addFeed } = await setup();
  const first = await addFeed("https://github.blog/feed/");
  const second = await addFeed("https://www.w3.org/blog/feed/");
  const visible = await addArticle(platform, user.id, first.feed.id, "First");
  const next = await addArticle(platform, user.id, second.feed.id, "Second");
  const at = await cursor();
  const ids = [first.subscriptionId, ...Array.from({ length: 89 }, () => crypto.randomUUID())];

  expect(
    (await mark({ subscriptionIds: [...ids, second.subscriptionId], cursor: at })).status,
  ).toBe(400);
  expect(await unread()).toEqual([visible, next].sort());
  expect(await (await mark({ subscriptionIds: ids, cursor: at })).json()).toEqual({ updated: 1 });
  expect(await unread()).toEqual([next]);
  expect(
    await (await mark({ subscriptionIds: [second.subscriptionId], cursor: at })).json(),
  ).toEqual({ updated: 1 });
  expect(await unread()).toEqual([]);
});
