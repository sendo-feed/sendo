import { describe, expect, it, vi } from "vitest";
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

type Bell = {
  id: string;
  subscriptionId: string | null;
  feedId: string | null;
  words: string | null;
  createdAt: string;
};
type SyncBell = (Bell & { deleted: false }) | { id: string; deleted: true };
type SyncPage = { cursor: string; hasMore: boolean; bells?: SyncBell[] };

/** 作った時刻が同じミリ秒になることがあるので、並びによらずに比べる */
const byId = (bells: readonly Bell[]) => [...bells].sort((a, b) => a.id.localeCompare(b.id));

/** 付ける文（bells への INSERT）の直前 */
const addStatement = /insert into "bells"/i;
/** 付ける文が入らなかったときに、理由を読み直す文の直前 */
const readBackStatement = /with subscription as/i;

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
      words: null,
      createdAt: expect.any(String),
    });
    expect(notified).toEqual([user.id]);
    expect(await list()).toEqual([bell]);
    expect((await sync(before.cursor)).bells).toEqual([{ ...bell, deleted: false }]);
  });

  it("同じミリ秒に作ったベルも、作った順に並ぶ（最初の同期と同じ順）", async () => {
    const { subscribe, added, list, sync } = await setup();
    const [one, two] = [await subscribe(), await subscribe()];
    // id の大小を、作った順と逆にする
    const [larger, smaller] = [crypto.randomUUID(), crypto.randomUUID()].sort().reverse();
    const first = await added({ id: larger, feedId: one.id });
    const second = await added({ id: smaller, feedId: two.id });
    // 2 つの付ける操作が DB の時計の同じミリ秒に入った状態を、作った時刻をそろえて作る
    await testDb
      .prepare("UPDATE bells SET created_at = ? WHERE id IN (?, ?)")
      .bind(new Date(first.createdAt).getTime(), first.id, second.id)
      .run();
    const sameMs = { ...second, createdAt: first.createdAt };

    expect(await list()).toEqual([first, sameMs]);
    expect((await sync()).bells).toEqual([
      { ...first, deleted: false },
      { ...sameMs, deleted: false },
    ]);
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

  it("ないフィードと入力の誤りには応じない", async () => {
    const { subscribe, add, remove, list } = await setup();
    const feed = await subscribe();
    expect((await add({ feedId: crypto.randomUUID() })).status).toBe(404);
    expect((await add({ feedId: crypto.randomUUID(), words: "障害" })).status).toBe(404);
    expect((await remove(crypto.randomUUID())).status).toBe(404);
    for (const json of [
      {},
      { id: crypto.randomUUID() },
      { feedId: feed.id, id: "NOT-A-UUID" },
      { feedId: feed.id, id: crypto.randomUUID().toUpperCase() },
      { feedId: feed.id, unknown: true },
      { words: 1 },
    ]) {
      const response = await add(json);
      expect(response.status, JSON.stringify(json)).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
    }
    expect(await list()).toEqual([]);
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

describe("言葉のベル", () => {
  it("言葉だけのベルは購読を持たずに付き、一覧と次の同期に届く。言葉は NFKC にして区切った形で返す", async () => {
    const { added, list, sync, user, notified } = await setup();
    const before = await sync();
    notified.length = 0;

    const bell = await added({ words: "  Ａｚｕｒｅ\u3000障害\t" });
    expect(bell).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      subscriptionId: null,
      feedId: null,
      words: "Azure 障害",
      createdAt: expect.any(String),
    });
    expect(notified).toEqual([user.id]);
    expect(await list()).toEqual([bell]);
    expect((await sync(before.cursor)).bells).toEqual([{ ...bell, deleted: false }]);
    expect((await sync()).bells).toEqual([{ ...bell, deleted: false }]);
  });

  it("購読 AND 言葉のベルは、購読と言葉の両方を持つ。購読だけ、言葉だけ、購読 AND 言葉は別のベル", async () => {
    const { subscribe, added, list } = await setup();
    const feed = await subscribe();

    const both = await added({ feedId: feed.id, words: "Rust" });
    expect(both).toMatchObject({
      subscriptionId: feed.subscriptionId,
      feedId: feed.id,
      words: "Rust",
    });
    const subscriptionOnly = await added({ feedId: feed.id });
    const wordsOnly = await added({ words: "Rust" });
    expect(new Set([both.id, subscriptionOnly.id, wordsOnly.id]).size).toBe(3);
    expect(byId(await list())).toEqual(byId([both, subscriptionOnly, wordsOnly]));
  });

  it("同じ言葉の集まりは、並びや大文字と小文字、全角と半角が違っても 1 つのベル。2 回目は最初の言葉のまま 200 で返す", async () => {
    const { subscribe, added, list, sync } = await setup();
    const feed = await subscribe();
    const words = await added({ words: "Azure 障害" });
    const both = await added({ feedId: feed.id, words: "Azure 障害" });
    const before = await sync();

    for (const again of ["障害 azure", "AZURE\u3000障害 Azure", "ａｚｕｒｅ 障害"]) {
      expect(await added({ words: again }, 200)).toEqual(words);
      expect(await added({ feedId: feed.id, words: again }, 200)).toEqual(both);
    }
    expect(byId(await list())).toEqual(byId([words, both]));
    expect((await sync(before.cursor)).bells).toEqual([]);
  });

  it("言葉は 8 個まで。重なりを除く前に 9 個でも、除いたあと 8 個なら付く", async () => {
    const { add, added } = await setup();
    const eight = Array.from({ length: 8 }, (_, i) => `w${i}`).join(" ");
    expect((await added({ words: eight })).words).toBe(eight);
    expect((await added({ words: `${eight} W0` }, 200)).words).toBe(eight);

    const nine = await add({ words: `${eight} w8` });
    expect(nine.status).toBe(400);
    expect(await nine.json()).toMatchObject({ error: { code: "invalid_request" } });
  });

  it("言葉は全体で 64 文字まで（区切りの空白を含むコードポイントの数）。65 文字は 400", async () => {
    const { add, added, list } = await setup();
    // 31 + 区切り 1 + 32 = 64 文字。絵文字はサロゲートの組でも 1 文字に数える
    const exact = `${"あ".repeat(31)} ${"\u{1F600}".repeat(32)}`;
    const bell = await added({ words: exact });
    expect(bell.words).toBe(exact);

    const over = await add({ words: `${exact}い` });
    expect(over.status).toBe(400);
    expect(await over.json()).toMatchObject({ error: { code: "invalid_request" } });
    expect(await list()).toEqual([bell]);
  });

  it("受ける文字列の長さでは断らない。余分な空白で長くても、区切ったあとが上限に収まれば受ける", async () => {
    const { added, list } = await setup();
    const bell = await added({ words: `Rust${" ".repeat(1021)}` });
    expect(bell.words).toBe("Rust");
    expect(await list()).toEqual([bell]);
  });

  it("言葉が空、空白だけ、制御文字や対になっていないサロゲートを含むなら 400 で、ベルを作らない", async () => {
    const { subscribe, add, list } = await setup();
    const feed = await subscribe();
    for (const words of ["", " \u3000\t\n", "障害\u0000", "\u007f", "Azure \ud800"]) {
      for (const json of [{ words }, { feedId: feed.id, words }]) {
        const response = await add(json);
        expect(response.status, JSON.stringify(json)).toBe(400);
        expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
      }
    }
    expect(await list()).toEqual([]);
  });

  it("購読をやめると、その購読の購読 AND 言葉のベルも消え、言葉だけのベルは残る", async () => {
    const { subscribe, added, list, request, sync } = await setup();
    const feed = await subscribe();
    const both = await added({ feedId: feed.id, words: "Rust" });
    const subscriptionOnly = await added({ feedId: feed.id });
    const wordsOnly = await added({ words: "Rust" });
    const before = await sync();

    expect((await request(`/feeds/${feed.id}`, "DELETE")).status).toBe(204);

    expect(await list()).toEqual([wordsOnly]);
    expect((await sync(before.cursor)).bells).toEqual(
      expect.arrayContaining([
        { id: both.id, deleted: true },
        { id: subscriptionOnly.id, deleted: true },
      ]),
    );
    expect((await sync(before.cursor)).bells).toHaveLength(2);
  });

  it("言葉だけのベルも有効なベルの上限に数える", async () => {
    const { subscribe, added, add } = await setup();
    const feed = await subscribe();
    for (let i = 0; i < MAX_BELLS; i++) await added({ words: `w${i}` });

    for (const json of [{ words: "over" }, { feedId: feed.id }, { feedId: feed.id, words: "w0" }]) {
      const response = await add(json);
      expect(response.status, JSON.stringify(json)).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code: "bell_limit_reached" } });
    }
    // 上限に達していても、同じ組のベルは今のものを返す
    expect((await added({ words: "W0" }, 200)).words).toBe("w0");
  });

  it("並びの違う同じ言葉を 2 つ同時に付けても、ベルは 1 つ。あとの方は先に入ったベルを 200 で返す", async () => {
    const { platform, user, list } = await setup();
    const bells = client(platform, user.token);

    let first: Bell | undefined;
    const hook = statementHook(addStatement, async () => {
      first = await bells.added({ words: "Azure 障害" });
    });
    const racer = client({ ...platform, db: hook.db }, user.token);
    const later = await racer.added({ words: "障害 AZURE" }, 200);

    expect(hook.fired()).toBe(true);
    expect(later).toEqual(first);
    expect(await list()).toEqual([first]);
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
    const hook = statementHook(readBackStatement, async () => {
      expect((await remove(existing.id)).status).toBe(204);
    });
    const racer = client({ ...platform, db: hook.db }, user.token);
    const bell = await racer.added({ feedId: feed.id }, 201);

    expect(hook.fired()).toBe(true);
    expect(bell.id).not.toBe(existing.id);
    expect(await list()).toEqual([bell]);
  });

  it("付ける文を 2 回流しても入らず、読み直してもどの理由にも当たらなければ 500", async () => {
    const { platform, user, subscribe, added, remove, list } = await setup();
    const feed = await subscribe();

    // 付ける文の直前には同じ購読のベルを付けてぶつけ、読み直す文の直前にはそれを外す。2 回とも
    let other: Bell | undefined;
    let fired = 0;
    const hook = statementHook(
      (sql) => addStatement.test(sql) || readBackStatement.test(sql),
      async () => {
        fired++;
        if (other) {
          expect((await remove(other.id)).status).toBe(204);
          other = undefined;
        } else {
          other = await added({ feedId: feed.id });
        }
        if (fired < 4) hook.arm();
      },
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const racer = client({ ...platform, db: hook.db }, user.token);
    const response = await racer.add({ feedId: feed.id });
    error.mockRestore();

    expect(fired).toBe(4);
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: { code: "internal_error" } });
    expect(await list()).toEqual([]);
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
    const unsubscribed = await subscribe();
    const bell = await added({ feedId: feed.id });
    const ended = await added({ feedId: unsubscribed.id });
    const before = await sync();
    expect((await remove(bell.id)).status).toBe(204);
    const middle = await sync(before.cursor);
    expect(middle.bells).toEqual([{ id: bell.id, deleted: true }]);
    // 購読をやめて印の付いたベルも、外したベルと同じに回収する
    expect((await request(`/feeds/${unsubscribed.id}`, "DELETE")).status).toBe(204);
    const current = await sync(middle.cursor);
    expect(current.bells).toEqual([{ id: ended.id, deleted: true }]);

    // 外してからちょうど 30 日は残し、それを過ぎたら消す
    now = new Date("2026-12-01T00:00:00Z");
    expect(await runCleanUp(platform)).toMatchObject({ bells: 0 });
    expect((await sync(before.cursor)).bells).toEqual([
      ...(middle.bells ?? []),
      ...(current.bells ?? []),
    ]);
    now = new Date("2026-12-01T00:00:00.001Z");
    expect(await runCleanUp(platform)).toMatchObject({ bells: 2 });
    for (const id of [bell.id, ended.id]) {
      expect(
        await testDb.prepare("SELECT count(*) AS n FROM bells WHERE id = ?").bind(id).first("n"),
      ).toBe(0);
    }
    // 外してしまえば 404（本人のベルがない）
    expect((await remove(bell.id)).status).toBe(404);

    // 購読をやめて付いた印の回収も、下限に記録する（その印より前のカーソルは続けられない）
    for (const cursor of [before.cursor, middle.cursor]) {
      const expired = await request(`/sync?includeBells=true&cursor=${cursor}`);
      expect(expired.status).toBe(400);
      expect(await expired.json()).toMatchObject({ error: { code: "invalid_cursor" } });
    }
    // ベルを受け取らないクライアントには、関係がない
    expect((await request(`/sync?cursor=${before.cursor}`)).status).toBe(200);
    // 回収したあとのカーソルは、そのまま続けられる
    expect((await sync(current.cursor)).bells).toEqual([]);
    expect((await sync()).bells).toEqual([]);
  });
});
