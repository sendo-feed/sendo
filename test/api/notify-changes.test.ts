import { describe, expect, it } from "vitest";
import { insertArticles } from "../../src/db/articles";
import type { Platform } from "../../src/platform";
import {
  addToInbox,
  createTestPlatform,
  createUser,
  recordingSyncUpdates,
  requestApp,
  subscribeFeed,
} from "../helpers";

/** 利用者の受信箱に未読の記事を 1 つ入れる */
async function inboxArticle(platform: Platform, userId: string) {
  const feed = await subscribeFeed(platform, { userId });
  const id = crypto.randomUUID();
  const now = new Date();
  await insertArticles(platform.db, [
    {
      id,
      feedId: feed.id,
      guid: id,
      url: null,
      title: "a",
      summary: null,
      author: null,
      publishedAt: now,
    },
  ]);
  await addToInbox(platform, [
    { articleId: id, feedId: feed.id, publishedAt: now, receivedAt: new Date(0), userId },
  ]);
  return { feed, articleId: id };
}

/** 知らせる範囲（docs/decisions/sync.md の 9）：状態を変えるリクエストが成功したら、その利用者に知らせる */
describe("状態を変えるリクエストの後の知らせ", () => {
  it("REST API：成功した書き込みだけを、その利用者に知らせる", async () => {
    const user = await createUser();
    const recording = recordingSyncUpdates();
    const { platform } = createTestPlatform({ syncUpdates: recording.syncUpdates });

    await requestApp(platform, "/api/v1/folders", { token: user.token });
    expect(recording.notified).toEqual([]);

    // 入力が正しくない書き込みは、何も変えないので知らせない
    const invalid = await requestApp(platform, "/api/v1/folders", {
      method: "POST",
      json: { name: "" },
      token: user.token,
    });
    expect(invalid.status).toBe(400);
    expect(recording.notified).toEqual([]);

    const created = await requestApp(platform, "/api/v1/folders", {
      method: "POST",
      json: { name: "Tech" },
      token: user.token,
    });
    expect(created.status).toBe(201);
    expect(recording.notified).toEqual([user.id]);
  });

  it("REST API：認証できないリクエストでは知らせない", async () => {
    const recording = recordingSyncUpdates();
    const { platform } = createTestPlatform({ syncUpdates: recording.syncUpdates });
    const res = await requestApp(platform, "/api/v1/folders", {
      method: "POST",
      json: { name: "Tech" },
      token: null,
    });
    expect(res.status).toBe(401);
    expect(recording.notified).toEqual([]);
  });

  it("REST API：既読・スターを変えても、知らせるのは入口の 1 回だけ", async () => {
    const user = await createUser();
    const recording = recordingSyncUpdates();
    const { platform } = createTestPlatform({ syncUpdates: recording.syncUpdates });
    const { articleId } = await inboxArticle(platform, user.id);

    const patched = await requestApp(platform, `/api/v1/articles/${articleId}`, {
      method: "PATCH",
      json: { read: true, starred: true },
      token: user.token,
    });
    expect(patched.status).toBe(200);
    expect(recording.notified).toEqual([user.id]);

    const marked = await requestApp(platform, "/api/v1/articles/mark-read", {
      method: "POST",
      json: { ids: [articleId] },
      token: user.token,
    });
    expect(marked.status).toBe(200);
    expect(recording.notified).toEqual([user.id, user.id]);
  });

  it("知らせに失敗しても、書き込みの応答は成功のまま返す", async () => {
    const user = await createUser();
    const recording = recordingSyncUpdates();
    const { platform } = createTestPlatform({
      syncUpdates: {
        ...recording.syncUpdates,
        async notify() {
          throw new Error("notifications unavailable");
        },
      },
    });
    const created = await requestApp(platform, "/api/v1/folders", {
      method: "POST",
      json: { name: "Tech" },
      token: user.token,
    });
    expect(created.status).toBe(201);
  });
});
