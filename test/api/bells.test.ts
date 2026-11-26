import { describe, expect, it } from "vitest";
import { decodeSyncCursor } from "../../src/api/sync";
import { MAX_BELLS } from "../../src/db/bells";
import { runCleanUp } from "../../src/jobs/clean-up";
import type { Platform } from "../../src/platform";
import { testDb } from "../db";
import {
  createTestPlatform,
  createUser,
  fakeFetch,
  recordingSyncUpdates,
  requestApp,
  statementHook,
  subscribeFeed,
  uniqueUrl,
} from "../helpers";

const rss = `<rss version="2.0"><channel><title>Blog</title>
<link>https://example.com/</link><item><title>Post</title></item></channel></rss>`;

type Bell = { id: string; subscriptionId: string; feedId: string; createdAt: string };
type SyncBell = (Bell & { deleted: false }) | { id: string; deleted: true };
type SyncPage = { cursor: string; hasMore: boolean; bells?: SyncBell[] };

/** 付ける文（bells への INSERT）の直前 */
const addStatement = /insert into "bells"/i;

/** 本番と同じ入口（REST API）で、購読して、ベルを付け外しし、同期する利用者 */
async function setup(overrides: Partial<Platform> = {}) {
  const { fetch } = fakeFetch(() => new Response(rss));
  const recording = recordingSyncUpdates();
  const { platform } = createTestPlatform({
    fetch,
    syncUpdates: recording.syncUpdates,
    ...overrides,
  });
  const user = await createUser();
  return { ...client(platform, user.token), platform, user, notified: recording.notified };
}

function client(platform: Platform, token: string) {
  const request = (path: string, method = "GET", json?: unknown) =>
    requestApp(platform, `/api/v1${path}`, { method, json, token });
  const subscribe = async (url = uniqueUrl()) => {
    const response = await request("/feeds", "POST", { url });
    expect(response.status).toBe(201);
    return ((await response.json()) as { feed: { id: string; subscriptionId: string } }).feed;
  };
  const add = (json: Record<string, unknown>) => request("/bells", "POST", json);
  const added = async (json: Record<string, unknown>, status = 201) => {
    const response = await add(json);
    expect(response.status).toBe(status);
    return ((await response.json()) as { bell: Bell }).bell;
  };
  const list = async () => {
    const response = await request("/bells");
    expect(response.status).toBe(200);
    return ((await response.json()) as { items: Bell[] }).items;
  };
  const remove = (id: string) => request(`/bells/${id}`, "DELETE");
  const sync = async (cursor?: string, include = true) => {
    const query = new URLSearchParams();
    if (cursor !== undefined) query.set("cursor", cursor);
    if (include) query.set("includeBells", "true");
    const response = await request(`/sync?${query}`);
    expect(response.status).toBe(200);
    return (await response.json()) as SyncPage;
  };
  return { request, subscribe, add, added, list, remove, sync };
}

describe("ベルの付け外し（REST API）", () => {
  it("付けたベルが次の同期で届き、同じ人の接続に知らせる", async () => {
    const { subscribe, added, list, sync, user, notified } = await setup();
    const feed = await subscribe();
    const before = await sync();
    notified.length = 0;

    const bell = await added({ feedId: feed.id });
    expect(bell).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      subscriptionId: feed.subscriptionId,
      feedId: feed.id,
      createdAt: expect.any(String),
    });
    expect(notified).toEqual([user.id]);
    expect(await list()).toEqual([bell]);
    expect((await sync(before.cursor)).bells).toEqual([{ ...bell, deleted: false }]);
  });

  it("新しく購読したばかりの購読には、ベルが付いていない", async () => {
    const { subscribe, list, sync } = await setup();
    await subscribe();
    expect(await list()).toEqual([]);
    expect((await sync()).bells).toEqual([]);
  });

  it("同じ購読に 2 回付けても 1 つのまま。2 回目は、送った id によらず今のベルを 200 で返す", async () => {
    const { subscribe, added, list, sync } = await setup();
    const feed = await subscribe();
    const id = crypto.randomUUID();
    const bell = await added({ id, feedId: feed.id });
    expect(bell.id).toBe(id);
    const before = await sync();

    expect(await added({ id, feedId: feed.id }, 200)).toEqual(bell);
    expect(await added({ id: crypto.randomUUID(), feedId: feed.id }, 200)).toEqual(bell);
    expect(await added({ feedId: feed.id }, 200)).toEqual(bell);
    expect(await list()).toEqual([bell]);
    // 何も変えていないので、差分にも出ない
    expect((await sync(before.cursor)).bells).toEqual([]);
  });

  it("外すと次の同期で削除の印が届き、もう一度外しても 204。付け直すと新しいベルになる", async () => {
    const { subscribe, added, list, remove, sync } = await setup();
    const feed = await subscribe();
    const bell = await added({ feedId: feed.id });
    const before = await sync();

    expect((await remove(bell.id)).status).toBe(204);
    expect((await remove(bell.id)).status).toBe(204);
    expect(await list()).toEqual([]);
    const removed = await sync(before.cursor);
    expect(removed.bells).toEqual([{ id: bell.id, deleted: true }]);
    // 外してあるベルをもう一度外しても、何も変えない（差分にも出ない）
    expect((await remove(bell.id)).status).toBe(204);
    expect((await sync(removed.cursor)).bells).toEqual([]);

    const again = await added({ feedId: feed.id });
    expect(again.id).not.toBe(bell.id);
    expect((await sync(removed.cursor)).bells).toEqual([{ ...again, deleted: false }]);
    // 最初の同期では、外したベルは送らない
    expect((await sync()).bells).toEqual([{ ...again, deleted: false }]);
  });

  it("購読をやめると、その購読のベルも消え、削除の印が届く。ほかの購読のベルは残る", async () => {
    const { subscribe, added, list, request, sync } = await setup();
    const feed = await subscribe();
    const kept = await subscribe();
    const bell = await added({ feedId: feed.id });
    const other = await added({ feedId: kept.id });
    const before = await sync();

    expect((await request(`/feeds/${feed.id}`, "DELETE")).status).toBe(204);
    expect(await list()).toEqual([other]);
    expect((await sync(before.cursor)).bells).toEqual([{ id: bell.id, deleted: true }]);

    // やめた購読にはもう付けられない
    expect((await request("/bells", "POST", { feedId: feed.id })).status).toBe(404);
  });

  it("購読し直したフィードには、新しい購読のベルとして付く", async () => {
    const { subscribe, added, request } = await setup();
    const url = uniqueUrl();
    const feed = await subscribe(url);
    const bell = await added({ feedId: feed.id });
    expect((await request(`/feeds/${feed.id}`, "DELETE")).status).toBe(204);

    const again = await subscribe(url);
    expect(again.id).toBe(feed.id);
    const next = await added({ feedId: feed.id });
    expect(next).toMatchObject({ feedId: feed.id, subscriptionId: again.subscriptionId });
    expect(next.subscriptionId).not.toBe(bell.subscriptionId);
  });

  it("ほかの人の購読には付けられず（404）、ほかの人のベルは外せない（404）", async () => {
    const owner = await setup();
    const url = uniqueUrl();
    const feed = await owner.subscribe(url);
    const bell = await owner.added({ feedId: feed.id });

    const other = client(owner.platform, (await createUser()).token);
    const denied = await other.add({ feedId: feed.id });
    expect(denied.status).toBe(404);
    expect(await denied.json()).toMatchObject({ error: { code: "not_found" } });
    expect((await other.remove(bell.id)).status).toBe(404);
    expect(await other.list()).toEqual([]);
    expect(await owner.list()).toEqual([bell]);

    // 同じフィードを自分で購読すれば、自分のベルを付けられる
    const own = await other.subscribe(url);
    expect(own.id).toBe(feed.id);
    const otherBell = await other.added({ feedId: feed.id });
    expect(otherBell.subscriptionId).toBe(own.subscriptionId);
    expect(await owner.list()).toEqual([bell]);
  });

  it("ないフィード、入力の誤り、言葉には応じない", async () => {
    const { subscribe, add, remove } = await setup();
    const feed = await subscribe();
    expect((await add({ feedId: crypto.randomUUID() })).status).toBe(404);
    expect((await remove(crypto.randomUUID())).status).toBe(404);
    for (const json of [
      {},
      { words: "障害" },
      { feedId: feed.id, words: "障害" },
      { feedId: feed.id, id: "NOT-A-UUID" },
      { feedId: feed.id, id: crypto.randomUUID().toUpperCase() },
    ]) {
      const response = await add(json);
      expect(response.status, JSON.stringify(json)).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
    }
  });

  it("指定した id がほかの行（外したベル、ほかの購読のベル、ほかの人のベル）に使われていれば 409", async () => {
    const { subscribe, added, add, remove, list } = await setup();
    const feed = await subscribe();
    const second = await subscribe();
    const removed = await added({ feedId: feed.id });
    expect((await remove(removed.id)).status).toBe(204);
    const active = await added({ feedId: second.id });

    const other = await setup();
    const otherBell = await other.added({ feedId: (await other.subscribe()).id });

    for (const id of [removed.id, active.id, otherBell.id]) {
      const response = await add({ id, feedId: feed.id });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code: "bell_id_taken" } });
    }
    expect(await list()).toEqual([active]);
  });
});

describe("ベルの上限", () => {
  /** 購読を count 個作る。作るのに手間がかかるので、購読はフィードを直接入れて作る */
  async function subscriptions(platform: Platform, userId: string, count: number) {
    const feeds = [];
    for (let i = 0; i < count; i++) feeds.push(await subscribeFeed(platform, { userId }));
    return feeds;
  }

  it(`有効なベルは ${MAX_BELLS} 個ちょうどまで付けられ、${MAX_BELLS + 1} 個目は 409。外せばまた付けられる`, async () => {
    const { platform, user, added, add, remove } = await setup();
    const feeds = await subscriptions(platform, user.id, MAX_BELLS + 1);
    const bells = [];
    for (const feed of feeds.slice(0, MAX_BELLS)) bells.push(await added({ feedId: feed.id }));

    const last = feeds.at(-1);
    if (!last) throw new Error("no feed");
    const over = await add({ feedId: last.id });
    expect(over.status).toBe(409);
    expect(await over.json()).toMatchObject({ error: { code: "bell_limit_reached" } });
    // 上限に達していても、同じ購読のベルは今のものを返す
    expect(await added({ feedId: bells[0]?.feedId }, 200)).toEqual(bells[0]);

    expect((await remove(bells[0]?.id ?? "")).status).toBe(204);
    expect((await add({ feedId: last.id })).status).toBe(201);
  });

  it("上限の 1 つ手前で 2 つ同時に付けても、上限を超えない", async () => {
    const { platform, user } = await setup();
    const feeds = await subscriptions(platform, user.id, MAX_BELLS + 1);
    const bells = client(platform, user.token);
    for (const feed of feeds.slice(0, MAX_BELLS - 1)) await bells.added({ feedId: feed.id });
    const [first, second] = feeds.slice(MAX_BELLS - 1);
    if (!first || !second) throw new Error("no feed");

    // 1 つ目を付ける文の直前に、2 つ目を付ける
    let racing: Response | undefined;
    const hook = statementHook(addStatement, async () => {
      racing = await bells.add({ feedId: second.id });
    });
    const racer = client({ ...platform, db: hook.db }, user.token);
    const response = await racer.add({ feedId: first.id });

    expect(hook.fired()).toBe(true);
    expect(racing?.status).toBe(201);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "bell_limit_reached" } });
    expect(await bells.list()).toHaveLength(MAX_BELLS);
  });
});

describe("ほかの操作と重なる", () => {
  it("同じ購読に 2 つ同時に付けても、ベルは 1 つ。あとの方は先に入ったベルを 200 で返す", async () => {
    const { platform, user, subscribe, list } = await setup();
    const feed = await subscribe();
    const bells = client(platform, user.token);

    let first: Bell | undefined;
    const hook = statementHook(addStatement, async () => {
      first = await bells.added({ feedId: feed.id });
    });
    const racer = client({ ...platform, db: hook.db }, user.token);
    const later = await racer.added({ id: crypto.randomUUID(), feedId: feed.id }, 200);

    expect(hook.fired()).toBe(true);
    expect(later).toEqual(first);
    expect(await list()).toEqual([first]);

    const parallel = await Promise.all([1, 2].map(() => bells.add({ feedId: feed.id })));
    expect(parallel.map((response) => response.status)).toEqual([200, 200]);
    expect(await list()).toEqual([first]);
  });

  it("付ける文の直前に購読をやめると、付かずに 404。有効なベルは残らない", async () => {
    const { platform, user, subscribe, list, request, sync } = await setup();
    const feed = await subscribe();
    const before = await sync();

    const hook = statementHook(addStatement, async () => {
      expect((await request(`/feeds/${feed.id}`, "DELETE")).status).toBe(204);
    });
    const racer = client({ ...platform, db: hook.db }, user.token);
    expect((await racer.add({ feedId: feed.id })).status).toBe(404);
    expect(hook.fired()).toBe(true);
    expect(await list()).toEqual([]);
    expect((await sync(before.cursor)).bells).toEqual([]);
  });

  it("購読をやめる文の直前に付けても、やめたあとに有効なベルは残らず、削除の印が届く", async () => {
    const { platform, user, subscribe, list, sync } = await setup();
    const feed = await subscribe();
    const before = await sync();
    const bells = client(platform, user.token);

    let bell: Bell | undefined;
    const hook = statementHook(/update "subscriptions" set "deleted_at"/i, async () => {
      bell = await bells.added({ feedId: feed.id });
    });
    const racer = client({ ...platform, db: hook.db }, user.token);
    expect((await racer.request(`/feeds/${feed.id}`, "DELETE")).status).toBe(204);

    expect(hook.fired()).toBe(true);
    expect(await list()).toEqual([]);
    const delta = await sync(before.cursor);
    expect(delta.bells).toEqual([{ id: bell?.id, deleted: true }]);
  });

  it("読み直す前に同じ購読のベルが外されたら、付ける文をもう一度流して付ける", async () => {
    const { platform, user, subscribe, added, remove, list } = await setup();
    const feed = await subscribe();
    const existing = await added({ feedId: feed.id });

    // 1 回目の付ける文は既存のベルにぶつかる。読み直す文の直前に、そのベルを外す
    const hook = statementHook(/with subscription as/i, async () => {
      expect((await remove(existing.id)).status).toBe(204);
    });
    const racer = client({ ...platform, db: hook.db }, user.token);
    const bell = await racer.added({ feedId: feed.id }, 201);

    expect(hook.fired()).toBe(true);
    expect(bell.id).not.toBe(existing.id);
    expect(await list()).toEqual([bell]);
  });
});

describe("ベルの差分同期", () => {
  it("includeBells を指定しないと bells もベルの位置も返さず、位置のないカーソルではベルを最初から送る", async () => {
    const { subscribe, added, sync, remove } = await setup();
    const feed = await subscribe();
    const removed = await added({ feedId: (await subscribe()).id });
    expect((await remove(removed.id)).status).toBe(204);
    const bell = await added({ feedId: feed.id });

    const legacy = await sync(undefined, false);
    expect(legacy).not.toHaveProperty("bells");
    expect(decodeSyncCursor(legacy.cursor)?.bells).toBeUndefined();

    // ベルの位置のない古いカーソルでは、今あるベルだけを送る（外したベルの印は送らない）
    const upgraded = await sync(legacy.cursor);
    expect(upgraded.bells).toEqual([{ ...bell, deleted: false }]);
    expect(decodeSyncCursor(upgraded.cursor)?.bells).toBeDefined();
    expect((await sync(upgraded.cursor)).bells).toEqual([]);

    // 指定を外すと、ベルの位置を持たないカーソルに戻る
    const dropped = await sync(upgraded.cursor, false);
    expect(dropped).not.toHaveProperty("bells");
    expect(decodeSyncCursor(dropped.cursor)?.bells).toBeUndefined();
  });

  it("外したベルの行は 30 日たつと片付けで消え、それより古いベルのカーソルは invalid_cursor", async () => {
    let now = new Date("2026-11-01T00:00:00Z");
    const { platform, subscribe, added, remove, sync, request } = await setup({ now: () => now });
    const feed = await subscribe();
    const bell = await added({ feedId: feed.id });
    const before = await sync();
    expect((await remove(bell.id)).status).toBe(204);
    const current = await sync(before.cursor);
    expect(current.bells).toEqual([{ id: bell.id, deleted: true }]);

    // 外してからちょうど 30 日は残し、それを過ぎたら消す
    now = new Date("2026-12-01T00:00:00Z");
    expect(await runCleanUp(platform)).toMatchObject({ bells: 0 });
    expect((await sync(before.cursor)).bells).toEqual([{ id: bell.id, deleted: true }]);
    now = new Date("2026-12-01T00:00:00.001Z");
    expect(await runCleanUp(platform)).toMatchObject({ bells: 1 });
    expect(
      await testDb.prepare("SELECT count(*) AS n FROM bells WHERE id = ?").bind(bell.id).first("n"),
    ).toBe(0);
    // 外してしまえば 404（本人のベルがない）
    expect((await remove(bell.id)).status).toBe(404);

    const expired = await request(`/sync?includeBells=true&cursor=${before.cursor}`);
    expect(expired.status).toBe(400);
    expect(await expired.json()).toMatchObject({ error: { code: "invalid_cursor" } });
    // ベルを受け取らないクライアントには、関係がない
    expect((await request(`/sync?cursor=${before.cursor}`)).status).toBe(200);
    // 回収したあとのカーソルは、そのまま続けられる
    expect((await sync(current.cursor)).bells).toEqual([]);
    expect((await sync()).bells).toEqual([]);
  });
});
