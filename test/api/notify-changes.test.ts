import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import {
  createTestPlatform,
  createUser,
  recordingSyncUpdates,
  requestApp,
  subscribeFeed,
} from "../helpers";

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

  it("Google Reader API：成功した書き込みを、その利用者に知らせる", async () => {
    const user = await createUser();
    const recording = recordingSyncUpdates();
    const { platform } = createTestPlatform({ syncUpdates: recording.syncUpdates });
    const feed = await subscribeFeed(platform, { userId: user.id });
    const send = (path: string, form?: Record<string, string>) =>
      createApp(platform).request(`https://sendo.example.com${path}`, {
        method: form ? "POST" : "GET",
        headers: {
          authorization: `GoogleLogin auth=${user.token}`,
          ...(form && { "content-type": "application/x-www-form-urlencoded" }),
        },
        ...(form && { body: new URLSearchParams(form).toString() }),
      });

    await send("/reader/api/0/subscription/list");
    expect(recording.notified).toEqual([]);

    const res = await send("/reader/api/0/subscription/edit", {
      ac: "edit",
      s: `feed/${feed.id}`,
      t: "ニュース",
    });
    expect(res.status).toBe(200);
    expect(recording.notified).toContain(user.id);
  });
});
