import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { QUERY_BUDGET } from "../../src/db/chunk";
import { clientSettings, seqFloors } from "../../src/db/schema";
import { SETTING_LIMITS } from "../../src/db/settings";
import { runCleanUp } from "../../src/jobs/clean-up";
import { createTestPlatform, createUser, requestApp } from "../helpers";

type Setting = { name: string; value: unknown };
type SyncSetting =
  | { deviceType: string; name: string; value: unknown; deleted: false }
  | { deviceType: string; name: string; deleted: true };
type SyncResponse = { cursor: string; hasMore: boolean; settings: SyncSetting[] };

const DAY = 24 * 60 * 60 * 1000;

/** テストごとに別のユーザーを使う（D1 はテストファイルの中で共有されるため） */
async function setUp(now?: () => Date) {
  const user = await createUser();
  const test = createTestPlatform(now ? { now } : {});
  const { platform } = test;
  const patch = (deviceType: string, json: unknown, token = user.token) =>
    requestApp(platform, `/api/v1/settings/${deviceType}`, { method: "PATCH", json, token });
  const list = async (deviceType: string, token = user.token) => {
    const res = await requestApp(platform, `/api/v1/settings/${deviceType}`, { token });
    expect(res.status).toBe(200);
    return ((await res.json()) as { items: Setting[] }).items;
  };
  /** hasMore が false になるまで同期して、届いた設定を順に返す */
  const sync = async (cursor?: string, token = user.token) => {
    const settings: SyncSetting[] = [];
    for (;;) {
      const query = cursor === undefined ? "" : `?cursor=${cursor}`;
      const res = await requestApp(platform, `/api/v1/sync${query}`, { token });
      expect(res.status).toBe(200);
      const body = (await res.json()) as SyncResponse;
      settings.push(...body.settings);
      cursor = body.cursor;
      if (!body.hasMore) return { settings, cursor };
    }
  };
  return { ...test, user, patch, list, sync };
}

describe("設定を置く ／ 消す", () => {
  it("置いた項目が、一覧と同期で、端末の種類ごとに返る", async () => {
    const { patch, list, sync } = await setUp();

    const res = await patch("mobile", {
      put: [
        { name: "reader.theme", value: "dark" },
        { name: "reader.list:/feeds/abc", value: { view: "titles", unreadOnly: true } },
      ],
    });
    expect(res.status).toBe(204);
    expect(
      (await patch("desktop", { put: [{ name: "reader.theme", value: "light" }] })).status,
    ).toBe(204);

    expect(await list("mobile")).toEqual([
      { name: "reader.list:/feeds/abc", value: { view: "titles", unreadOnly: true } },
      { name: "reader.theme", value: "dark" },
    ]);
    expect(await list("desktop")).toEqual([{ name: "reader.theme", value: "light" }]);

    // 同期では、どちらの種類も届く
    const { settings } = await sync();
    expect(settings).toHaveLength(3);
    expect(settings).toContainEqual({
      deviceType: "mobile",
      name: "reader.theme",
      value: "dark",
      deleted: false,
    });
    expect(settings).toContainEqual({
      deviceType: "desktop",
      name: "reader.theme",
      value: "light",
      deleted: false,
    });
  });

  it("JSON の値は、どの形でもそのまま返る", async () => {
    const { patch, list } = await setUp();
    const values: unknown[] = [
      null,
      false,
      0,
      -1.5,
      "",
      '日本語 "引用" \\ \n 😀',
      [],
      {},
      [1, "a", null, { b: [true] }],
      { キー: { nested: [1, 2, 3] }, "a.b": "c" },
      '{"looks":"like json"}',
    ];
    const put = values.map((value, i) => ({
      name: `reader.v${String(i).padStart(2, "0")}`,
      value,
    }));

    expect((await patch("desktop", { put })).status).toBe(204);

    expect(await list("desktop")).toEqual(put);
  });

  it("別の項目を別々に変えても、どちらも残る。同じ項目は、後から受けたほうを採る", async () => {
    const { patch, list } = await setUp();
    await patch("mobile", {
      put: [
        { name: "reader.theme", value: "dark" },
        { name: "reader.font", value: 16 },
      ],
    });

    // 2 台が、それぞれ別の項目を変える
    await patch("mobile", { put: [{ name: "reader.theme", value: "light" }] });
    await patch("mobile", { put: [{ name: "reader.font", value: 18 }] });
    expect(await list("mobile")).toEqual([
      { name: "reader.font", value: 18 },
      { name: "reader.theme", value: "light" },
    ]);

    // 同じ項目
    await patch("mobile", { put: [{ name: "reader.theme", value: "sepia" }] });
    expect(await list("mobile")).toContainEqual({ name: "reader.theme", value: "sepia" });
  });

  it("変えた項目だけが、差分で届く。同じ値の置き直しは届かない", async () => {
    const { patch, sync } = await setUp();
    await patch("mobile", {
      put: [
        { name: "reader.theme", value: "dark" },
        { name: "reader.font", value: 16 },
      ],
    });
    const first = await sync();

    // 送り直し（同じ値）と、1 つだけ違う値
    await patch("mobile", {
      put: [
        { name: "reader.theme", value: "dark" },
        { name: "reader.font", value: 18 },
      ],
    });
    const second = await sync(first.cursor);
    expect(second.settings).toEqual([
      { deviceType: "mobile", name: "reader.font", value: 18, deleted: false },
    ]);

    // まったく同じものを送り直しても、何も届かない
    expect(
      (
        await patch("mobile", {
          put: [
            { name: "reader.theme", value: "dark" },
            { name: "reader.font", value: 18 },
          ],
        })
      ).status,
    ).toBe(204);
    expect((await sync(second.cursor)).settings).toEqual([]);
  });

  it("消した項目は、差分で消した印として届き、一覧と最初の同期には出ない。置き直すと戻る", async () => {
    const { patch, list, sync } = await setUp();
    await patch("desktop", {
      put: [
        { name: "reader.theme", value: "dark" },
        { name: "reader.font", value: 16 },
      ],
    });
    const first = await sync();

    expect((await patch("desktop", { remove: ["reader.theme", "reader.unknown"] })).status).toBe(
      204,
    );

    expect(await list("desktop")).toEqual([{ name: "reader.font", value: 16 }]);
    const second = await sync(first.cursor);
    expect(second.settings).toEqual([
      { deviceType: "desktop", name: "reader.theme", deleted: true },
    ]);
    expect((await sync()).settings).toEqual([
      { deviceType: "desktop", name: "reader.font", value: 16, deleted: false },
    ]);

    // もう消してある項目を消しても、何も届かない
    await patch("desktop", { remove: ["reader.theme"] });
    expect((await sync(second.cursor)).settings).toEqual([]);

    // 同じ値で置き直しても、消した印が外れて届く
    await patch("desktop", { put: [{ name: "reader.theme", value: "dark" }] });
    expect((await sync(second.cursor)).settings).toEqual([
      { deviceType: "desktop", name: "reader.theme", value: "dark", deleted: false },
    ]);
    expect(await list("desktop")).toHaveLength(2);
  });

  it("1 回のリクエストで、置くのと消すのを一緒にできる", async () => {
    const { patch, list } = await setUp();
    await patch("mobile", { put: [{ name: "reader.a", value: 1 }] });

    const res = await patch("mobile", {
      put: [{ name: "reader.b", value: 2 }],
      remove: ["reader.a"],
    });

    expect(res.status).toBe(204);
    expect(await list("mobile")).toEqual([{ name: "reader.b", value: 2 }]);
  });

  it("ほかの人の設定は見えず、変えられない", async () => {
    const { patch, list, sync } = await setUp();
    const other = await createUser();
    await patch("mobile", { put: [{ name: "reader.theme", value: "dark" }] });

    expect(await list("mobile", other.token)).toEqual([]);
    expect((await sync(undefined, other.token)).settings).toEqual([]);

    await patch("mobile", { put: [{ name: "reader.theme", value: "light" }] }, other.token);
    await patch("mobile", { remove: ["reader.theme"] }, other.token);
    expect(await list("mobile")).toEqual([{ name: "reader.theme", value: "dark" }]);
  });

  it("認証がなければ断る", async () => {
    const { platform } = await setUp();
    const res = await requestApp(platform, "/api/v1/settings/mobile", { token: null });
    expect(res.status).toBe(401);
  });

  it("使うクエリは、いちばん多い場合でも上限に収まる", async () => {
    const { patch, queryCount, resetQueryCount } = await setUp();
    const put = Array.from({ length: 50 }, (_, i) => ({ name: `reader.a${i}`, value: i }));
    await patch("mobile", { put });

    // 消して、置いて、同じ値の項目が混ざっている（置けたかを読み直す）
    resetQueryCount();
    const res = await patch("mobile", {
      put: put.slice(0, 50).map((item, i) => (i < 25 ? item : { ...item, value: "new" })),
      remove: Array.from({ length: 50 }, (_, i) => `reader.b${i}`),
    });

    expect(res.status).toBe(204);
    expect(queryCount()).toBeLessThanOrEqual(QUERY_BUDGET);
  });
});

describe("設定の同期：同じ番号の途中のカーソル", () => {
  it("まとめて消した項目の途中まで受け取ったカーソルも、回収のあとは最初から同期し直させる", async () => {
    let now = new Date("2026-03-01T00:00:00Z");
    const { platform, patch, sync, user } = await setUp(() => now);
    const names = ["reader.a", "reader.b", "reader.c"];
    await patch("mobile", { put: names.map((name) => ({ name, value: 1 })) });
    const first = await sync();
    // 1 回のリクエストで消すと、消した印の行は同じ番号になる
    await patch("mobile", { remove: names });
    const rows = await platform.db
      .select()
      .from(clientSettings)
      .where(eq(clientSettings.userId, user.id))
      .orderBy(clientSettings.id)
      .all();
    expect(new Set(rows.map((row) => row.seq)).size).toBe(1);

    // 1 つ目の消した印まで受け取った位置のカーソルを作る（ページの境目が、同じ番号の途中に来た場合）
    const decoded = JSON.parse(atob(first.cursor.replaceAll("-", "+").replaceAll("_", "/")));
    decoded.c = [rows[0]?.seq, rows[0]?.id, null, false];
    const middle = btoa(JSON.stringify(decoded))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "");
    expect((await sync(middle)).settings).toHaveLength(2);
    // その番号をすべて受け取ったカーソル
    const done = (await sync(first.cursor)).cursor;

    now = new Date(now.getTime() + 31 * DAY);
    expect((await runCleanUp(platform)).settings).toBeGreaterThanOrEqual(3);

    const res = await requestApp(platform, `/api/v1/sync?cursor=${middle}`, { token: user.token });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("invalid_cursor");
    expect((await sync(done)).settings).toEqual([]);
  });
});

describe("設定の入力の確かめ", () => {
  it.each([
    ["端末の種類が違う", "tablet", { put: [{ name: "reader.a", value: 1 }] }],
    ["名前にクライアントがない", "mobile", { put: [{ name: "theme", value: 1 }] }],
    ["名前のクライアントが大文字", "mobile", { put: [{ name: "Reader.theme", value: 1 }] }],
    ["名前に空白", "mobile", { put: [{ name: "reader.a b", value: 1 }] }],
    ["名前に ASCII でない文字", "mobile", { put: [{ name: "reader.テーマ", value: 1 }] }],
    ["名前が長い", "mobile", { put: [{ name: `reader.${"a".repeat(122)}`, value: 1 }] }],
    ["消す名前の形が違う", "mobile", { remove: ["theme"] }],
    ["値がない", "mobile", { put: [{ name: "reader.a" }] }],
    ["同じ名前が 2 度", "mobile", { put: [{ name: "reader.a", value: 1 }], remove: ["reader.a"] }],
    [
      "値が大きい",
      "mobile",
      { put: [{ name: "reader.a", value: "x".repeat(SETTING_LIMITS.valueBytes - 1) }] },
    ],
    [
      "値が大きい（バイトで数える）",
      "mobile",
      { put: [{ name: "reader.a", value: "あ".repeat(Math.ceil(SETTING_LIMITS.valueBytes / 3)) }] },
    ],
    [
      "値の入れ子が深い",
      "mobile",
      {
        put: [
          {
            name: "reader.a",
            value: JSON.parse(
              "[".repeat(SETTING_LIMITS.valueDepth + 1) + "]".repeat(SETTING_LIMITS.valueDepth + 1),
            ),
          },
        ],
      },
    ],
    [
      "項目が多い",
      "mobile",
      {
        put: Array.from({ length: SETTING_LIMITS.requestItems }, (_, i) => ({
          name: `reader.a${i}`,
          value: i,
        })),
        remove: ["reader.b"],
      },
    ],
  ])("%s なら 400", async (_title, deviceType, json) => {
    const { patch, list } = await setUp();

    const res = await patch(deviceType, json);

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("invalid_request");
    expect(await list("mobile")).toEqual([]);
  });

  it("上限ちょうどの名前・値・入れ子・項目の数は通る", async () => {
    const { patch, list } = await setUp();
    const depth = SETTING_LIMITS.valueDepth;

    const res = await patch("mobile", {
      put: [
        { name: `reader.${"a".repeat(SETTING_LIMITS.nameLength - 7)}`, value: 1 },
        // 引用符の 2 バイトを足して、ちょうど上限
        { name: "reader.big", value: "x".repeat(SETTING_LIMITS.valueBytes - 2) },
        { name: "reader.deep", value: JSON.parse("[".repeat(depth) + "]".repeat(depth)) },
        ...Array.from({ length: SETTING_LIMITS.requestItems - 3 }, (_, i) => ({
          name: `reader.n${i}`,
          value: i,
        })),
      ],
    });

    expect(res.status).toBe(204);
    expect(await list("mobile")).toHaveLength(SETTING_LIMITS.requestItems);
  });

  it("本文が大きすぎれば 413", async () => {
    const { patch } = await setUp();

    const res = await patch("mobile", { put: [], padding: "x".repeat(1024 * 1024) });

    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("too_large");
  });
});

describe("設定の上限", () => {
  /** 上限まで項目を置く */
  async function fill(patch: Awaited<ReturnType<typeof setUp>>["patch"], deviceType: string) {
    for (let i = 0; i < SETTING_LIMITS.items; i += SETTING_LIMITS.requestItems) {
      const put = Array.from({ length: SETTING_LIMITS.requestItems }, (_, j) => ({
        name: `reader.n${i + j}`,
        value: i + j,
      }));
      expect((await patch(deviceType, { put })).status).toBe(204);
    }
  }

  it("項目の数を超えるなら、1 つも置かずに 409。端末の種類ごとに数える", async () => {
    const { patch, list } = await setUp();
    await fill(patch, "mobile");

    // 今ある項目の置き換えと、新しい項目が混ざっている
    const res = await patch("mobile", {
      put: [
        { name: "reader.n0", value: "changed" },
        { name: "reader.extra", value: 1 },
      ],
    });

    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("settings_full");
    const items = await list("mobile");
    expect(items).toHaveLength(SETTING_LIMITS.items);
    expect(items).toContainEqual({ name: "reader.n0", value: 0 });

    // もう一方の種類には、置ける
    expect((await patch("desktop", { put: [{ name: "reader.extra", value: 1 }] })).status).toBe(
      204,
    );
  });

  it("上限いっぱいでも、今ある項目の置き換えと、同じ値の送り直しは通る", async () => {
    const { patch, list } = await setUp();
    await fill(patch, "mobile");

    expect((await patch("mobile", { put: [{ name: "reader.n0", value: "changed" }] })).status).toBe(
      204,
    );
    expect((await patch("mobile", { put: [{ name: "reader.n1", value: 1 }] })).status).toBe(204);
    expect(await list("mobile")).toContainEqual({ name: "reader.n0", value: "changed" });
  });

  it("上限いっぱいでも、同じリクエストで消した分だけ置ける。消した印の行は数えない", async () => {
    const { patch, list } = await setUp();
    await fill(patch, "mobile");

    const res = await patch("mobile", {
      put: [{ name: "reader.extra", value: 1 }],
      remove: ["reader.n0"],
    });

    expect(res.status).toBe(204);
    const items = await list("mobile");
    expect(items).toHaveLength(SETTING_LIMITS.items);
    expect(items).toContainEqual({ name: "reader.extra", value: 1 });
  });

  it("名前と値の合計を超えるなら、1 つも置かずに 409", async () => {
    const { patch, list } = await setUp();
    // 1 項目が 8KB ほど。32 項目で 256KB に届く
    const big = (i: number) => ({
      name: `reader.big${i}`,
      value: "x".repeat(SETTING_LIMITS.valueBytes - 100),
    });
    const count = Math.floor(SETTING_LIMITS.totalBytes / (SETTING_LIMITS.valueBytes - 80));
    expect(
      (await patch("mobile", { put: Array.from({ length: count }, (_, i) => big(i)) })).status,
    ).toBe(204);

    const res = await patch("mobile", {
      put: [{ name: "reader.small", value: 1 }, big(count)],
    });

    expect(res.status).toBe(409);
    expect(await list("mobile")).toHaveLength(count);

    // 大きい項目を小さい値に置き換えれば、空きができる
    expect((await patch("mobile", { put: [{ name: "reader.big0", value: 1 }] })).status).toBe(204);
    expect((await patch("mobile", { put: [big(count)] })).status).toBe(204);
  });
});

describe("設定の同期", () => {
  it("設定の位置を持たない古いカーソルには、設定だけを最初から送る", async () => {
    const { patch, sync } = await setUp();
    await patch("mobile", { put: [{ name: "reader.theme", value: "dark" }] });
    const { cursor } = await sync();

    // 設定を足す前のカーソルの形（設定の位置がない）にする
    const decoded = JSON.parse(atob(cursor.replaceAll("-", "+").replaceAll("_", "/")));
    delete decoded.c;
    const old = btoa(JSON.stringify(decoded)).replaceAll("+", "-").replaceAll("/", "_");

    const { settings } = await sync(old.replace(/=+$/, ""));
    expect(settings).toEqual([
      { deviceType: "mobile", name: "reader.theme", value: "dark", deleted: false },
    ]);
  });

  it("項目が多くても、区切って送り切る", async () => {
    const { patch, sync } = await setUp();
    for (let i = 0; i < 600; i += 100) {
      const put = Array.from({ length: 100 }, (_, j) => ({
        name: `reader.n${i + j}`,
        value: i + j,
      }));
      await patch(i % 200 === 0 ? "mobile" : "desktop", { put });
    }

    const { settings } = await sync();

    expect(new Set(settings.map((item) => `${item.deviceType} ${item.name}`)).size).toBe(600);
  });

  it("消した印の行は 30 日で回収し、それより古いカーソルには最初から同期し直させる", async () => {
    let now = new Date("2026-01-01T00:00:00Z");
    const { platform, patch, sync, user } = await setUp(() => now);
    await patch("mobile", {
      put: [
        { name: "reader.theme", value: "dark" },
        { name: "reader.font", value: 16 },
      ],
    });
    const before = await sync();
    await patch("mobile", { remove: ["reader.theme"] });
    const after = await sync(before.cursor);
    expect(after.settings).toHaveLength(1);

    // 29 日では回収しない
    now = new Date(now.getTime() + 29 * DAY);
    await runCleanUp(platform);
    expect((await sync(before.cursor)).settings).toHaveLength(1);

    now = new Date(now.getTime() + 2 * DAY);
    expect((await runCleanUp(platform)).settings).toBeGreaterThanOrEqual(1);
    const rows = await platform.db
      .select()
      .from(clientSettings)
      .where(eq(clientSettings.userId, user.id))
      .all();
    expect(rows.map((row) => row.name)).toEqual(["reader.font"]);

    // 消したことを受け取っていないカーソルは、最初から同期し直す
    const res = await requestApp(platform, `/api/v1/sync?cursor=${before.cursor}`, {
      token: user.token,
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("invalid_cursor");
    // 受け取ったカーソルと、最初からの同期は通る
    expect((await sync(after.cursor)).settings).toEqual([]);
    const fresh = await sync();
    expect(fresh.settings).toHaveLength(1);
    expect((await sync(fresh.cursor)).settings).toEqual([]);

    // 回収した行の番号は、二度と使わない
    const floor = await platform.db
      .select()
      .from(seqFloors)
      .where(eq(seqFloors.tableName, "client_settings"))
      .get();
    await patch("mobile", { put: [{ name: "reader.theme", value: "light" }] });
    const revived = await platform.db
      .select()
      .from(clientSettings)
      .where(sql`${clientSettings.userId} = ${user.id} and ${clientSettings.name} = 'reader.theme'`)
      .get();
    expect(revived?.seq).toBeGreaterThan(floor?.floor ?? Number.POSITIVE_INFINITY);
    expect((await sync(fresh.cursor)).settings).toEqual([
      { deviceType: "mobile", name: "reader.theme", value: "light", deleted: false },
    ]);
  });
});
