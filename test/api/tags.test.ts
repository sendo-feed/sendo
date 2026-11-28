import { describe, expect, it } from "vitest";
import { decodeSyncCursor } from "../../src/api/sync";
import { MAX_TAGS } from "../../src/db/tags";
import { runCleanUp } from "../../src/jobs/clean-up";
import type { Platform } from "../../src/platform";
import { testDb } from "../db";
import {
  createTestPlatform,
  createUser,
  recordingSyncUpdates,
  requestApp,
  statementHook,
} from "../helpers";

/*
 * タグの REST API と差分同期（docs/decisions/tags.md の 4、6、7）。本番と同じ入口（REST API）から呼ぶ
 */

type Tag = { id: string; name: string; description: string; createdAt: string };
type SyncTag = (Tag & { deleted: false }) | { id: string; deleted: true };
type SyncPage = { cursor: string; hasMore: boolean; tags?: SyncTag[] };

/** 作る文（tags への INSERT）の直前 */
const createStatement = /insert into "tags"/i;
/** 作る文が入らなかったときに、理由を読み直す文の直前 */
const readBackStatement = /left join "tags" as existing/i;

async function setup(overrides: Partial<Platform> = {}) {
  const recording = recordingSyncUpdates();
  const { platform } = createTestPlatform({ syncUpdates: recording.syncUpdates, ...overrides });
  const user = await createUser();
  return { ...client(platform, user.token), platform, user, notified: recording.notified };
}

function client(platform: Platform, token: string) {
  const request = (path: string, method = "GET", json?: unknown) =>
    requestApp(platform, `/api/v1${path}`, { method, json, token });
  const create = (json: Record<string, unknown>) => request("/tags", "POST", json);
  const created = async (json: Record<string, unknown>, status = 201) => {
    const response = await create(json);
    expect(response.status).toBe(status);
    return ((await response.json()) as { tag: Tag }).tag;
  };
  const list = async () => {
    const response = await request("/tags");
    expect(response.status).toBe(200);
    return (await response.json()) as { items: Tag[]; rejudgeRemaining: number };
  };
  const update = (id: string, json: Record<string, unknown>) =>
    request(`/tags/${id}`, "PATCH", json);
  const remove = (id: string) => request(`/tags/${id}`, "DELETE");
  const sync = async (cursor?: string, include = true) => {
    const query = new URLSearchParams();
    if (cursor !== undefined) query.set("cursor", cursor);
    if (include) query.set("includeTags", "true");
    const response = await request(`/sync?${query}`);
    expect(response.status).toBe(200);
    return (await response.json()) as SyncPage;
  };
  return { request, create, created, list, update, remove, sync };
}

const errorCode = async (response: Response) =>
  ((await response.json()) as { error: { code: string } }).error.code;

describe("タグの作成・変更・削除（REST API）", () => {
  it("作ったタグが一覧と次の同期に届き、同じ人の接続に知らせる", async () => {
    const { created, list, sync, notified, user } = await setup();
    const first = await sync();
    const tag = await created({ name: "  Rust  ", description: " プログラミング言語 " });
    expect(tag).toMatchObject({ name: "Rust", description: "プログラミング言語" });
    expect(await list()).toEqual({ items: [tag], rejudgeRemaining: 0 });
    expect((await sync(first.cursor)).tags).toEqual([{ ...tag, deleted: false }]);
    expect(notified).toContainEqual(user.id);
  });

  it("名前は 1〜64、説明は 0〜140 コードポイントで、上限ちょうどは受け、超える・空・制御文字は 400", async () => {
    const { create, created } = await setup();
    // 絵文字は UTF-16 で 2 単位だが、コードポイントで数える
    await created({ name: "😀".repeat(64), description: "😀".repeat(140) });
    await created({ name: "a" });
    for (const body of [
      { name: "😀".repeat(65) },
      { name: "b", description: "😀".repeat(141) },
      { name: "" },
      { name: "   " },
      { name: "a\u0007b" },
      { name: "c", description: "改行\nを含む" },
      { name: "\ud800d" },
      { name: "e", extra: true },
    ]) {
      const response = await create(body);
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect(
      await testDb
        .prepare("SELECT count(*) AS n FROM tags WHERE name LIKE 'b%' OR name = ''")
        .first("n"),
    ).toBe(0);
  });

  it("同じ照合用の名前の有効なタグがあれば、id と説明によらず 200 でそれを返す。版の付いた名前は別のタグ", async () => {
    const { created, list } = await setup();
    const rust = await created({ name: "Kubernetes", description: "コンテナ" });
    const again = await created(
      { id: crypto.randomUUID(), name: "ＫＵＢＥＲＮＥＴＥＳ", description: "別の説明" },
      200,
    );
    expect(again).toEqual(rust);
    const python = await created({ name: "Python" });
    const versioned = await created({ name: "Python 3.13" });
    expect(versioned.id).not.toBe(python.id);
    expect((await list()).items.map((tag) => tag.name)).toEqual([
      "Kubernetes",
      "Python",
      "Python 3.13",
    ]);
  });

  it("指定した id がほかの行（消したタグ、ほかの人のタグ）に使われていれば 409（tag_id_taken）", async () => {
    const owner = await setup();
    const removed = await owner.created({ name: "消すタグ" });
    expect((await owner.remove(removed.id)).status).toBe(204);
    const response = await owner.create({ id: removed.id, name: "新しいタグ" });
    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe("tag_id_taken");

    const other = client(owner.platform, (await createUser()).token);
    const mine = await owner.created({ name: "私のタグ" });
    const taken = await other.create({ id: mine.id, name: "別の人のタグ" });
    expect(await errorCode(taken)).toBe("tag_id_taken");
  });

  it("名前と説明を変えると次の同期に届く。ほかの有効なタグと同じ照合用の名前には変えられない（tag_name_taken）", async () => {
    const { created, update, sync } = await setup();
    const go = await created({ name: "Go" });
    const rust = await created({ name: "Rust" });
    const before = await sync();
    const response = await update(go.id, {
      name: " Golang ",
      description: "プログラミング言語の Go",
    });
    expect(response.status).toBe(200);
    const changed = ((await response.json()) as { tag: Tag }).tag;
    expect(changed).toEqual({ ...go, name: "Golang", description: "プログラミング言語の Go" });
    expect((await sync(before.cursor)).tags).toEqual([{ ...changed, deleted: false }]);

    const taken = await update(go.id, { name: "RUST" });
    expect(taken.status).toBe(409);
    expect(await errorCode(taken)).toBe("tag_name_taken");
    // 自分と同じ照合用の名前への変更（表記だけを変える）はできる
    expect((await update(rust.id, { name: "RUST" })).status).toBe(200);
    expect((await update(go.id, { name: "" })).status).toBe(400);
    expect((await update(crypto.randomUUID(), { name: "X" })).status).toBe(404);
  });

  it("消すと次の同期で削除の印が届き、本人が消したタグの再送も 204。ほかの人のタグは 404", async () => {
    const owner = await setup();
    const tag = await owner.created({ name: "消すタグ" });
    const before = await owner.sync();
    const other = client(owner.platform, (await createUser()).token);
    expect((await other.remove(tag.id)).status).toBe(404);
    expect((await other.update(tag.id, { name: "乗っ取り" })).status).toBe(404);

    expect((await owner.remove(tag.id)).status).toBe(204);
    expect((await owner.remove(tag.id)).status).toBe(204);
    expect((await owner.sync(before.cursor)).tags).toEqual([{ id: tag.id, deleted: true }]);
    expect((await owner.list()).items).toEqual([]);
    // 消したタグは変えられない
    expect((await owner.update(tag.id, { name: "生き返らせる" })).status).toBe(404);
    // 同じ名前で作り直すと、新しいタグになる
    const again = await owner.created({ name: "消すタグ" });
    expect(again.id).not.toBe(tag.id);
  });
});

describe("タグの上限", () => {
  it(`有効なタグは ${MAX_TAGS} 個ちょうどまで作れ、${MAX_TAGS + 1} 個目は 409。同じ名前は上限でも 200。消せばまた作れる`, async () => {
    const { created, create, remove } = await setup();
    const tags: Tag[] = [];
    for (let i = 0; i < MAX_TAGS; i++) tags.push(await created({ name: `タグ ${i}` }));
    const over = await create({ name: "あふれるタグ" });
    expect(over.status).toBe(409);
    expect(await errorCode(over)).toBe("tag_limit_reached");
    // 同じ照合用の名前の有効なタグは、上限によらず 200
    expect(await created({ name: "タグ 0" }, 200)).toEqual(tags[0]);
    // 上限と id の重なりが重なったら、上限を先に返す
    const both = await create({ id: tags[1]?.id, name: "あふれるタグ" });
    expect(await errorCode(both)).toBe("tag_limit_reached");
    expect((await remove(tags[2]?.id ?? "")).status).toBe(204);
    await created({ name: "あふれるタグ" });
  });

  it("上限の 1 つ手前で 2 つ同時に作っても、上限を超えない", async () => {
    const { created, platform, user } = await setup();
    for (let i = 0; i < MAX_TAGS - 1; i++) await created({ name: `タグ ${i}` });
    const other = client(platform, user.token);
    const responses = await Promise.all([
      other.create({ name: "同時 A" }),
      other.create({ name: "同時 B" }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(
      await testDb
        .prepare("SELECT count(*) AS n FROM tags WHERE user_id = ? AND deleted_at IS NULL")
        .bind(user.id)
        .first("n"),
    ).toBe(MAX_TAGS);
  });
});

describe("ほかの操作と重なる", () => {
  it("同じ名前を 2 つ同時に作っても、タグは 1 つ。あとの方は先に入ったタグを 200 で返す", async () => {
    let second: Response | undefined;
    const hook = statementHook(createStatement, async () => {
      second = await owner.create({ name: "rust" });
    });
    const owner = await setup();
    const hooked = client({ ...owner.platform, db: hook.db }, owner.user.token);
    const first = await hooked.create({ name: "Rust" });
    expect(hook.fired()).toBe(true);
    expect(second?.status).toBe(201);
    expect(first.status).toBe(200);
    expect((await owner.list()).items).toHaveLength(1);
  });

  it("読み直す前に同じ名前のタグが消されたら、作る文をもう一度流して作る", async () => {
    const owner = await setup();
    const existing = await owner.created({ name: "Rust" });
    const hook = statementHook(readBackStatement, async () => {
      await owner.remove(existing.id);
    });
    const hooked = client({ ...owner.platform, db: hook.db }, owner.user.token);
    const response = await hooked.create({ name: "rust" });
    expect(hook.fired()).toBe(true);
    expect(response.status).toBe(201);
    const tag = ((await response.json()) as { tag: Tag }).tag;
    expect(tag.id).not.toBe(existing.id);
  });

  it("名前を変える文の直前に、同じ照合用の名前のタグが作られたら、変えずに 409", async () => {
    const owner = await setup();
    const go = await owner.created({ name: "Go" });
    const hook = statementHook(/update "tags" set name/i, async () => {
      await owner.created({ name: "Golang" });
    });
    const hooked = client({ ...owner.platform, db: hook.db }, owner.user.token);
    const response = await hooked.update(go.id, { name: "golang" });
    expect(hook.fired()).toBe(true);
    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe("tag_name_taken");
  });
});

describe("タグの差分同期", () => {
  it("includeTags を指定しないと tags もタグの位置も返さず、位置のないカーソルではタグを最初から送る", async () => {
    const { created, sync, remove } = await setup();
    const removed = await created({ name: "消したタグ" });
    expect((await remove(removed.id)).status).toBe(204);
    const tag = await created({ name: "Rust" });

    const legacy = await sync(undefined, false);
    expect(legacy).not.toHaveProperty("tags");
    expect(decodeSyncCursor(legacy.cursor)?.tags).toBeUndefined();

    // タグの位置のない古いカーソルでは、今あるタグだけを送る（消したタグの印は送らない）
    const upgraded = await sync(legacy.cursor);
    expect(upgraded.tags).toEqual([{ ...tag, deleted: false }]);
    expect(decodeSyncCursor(upgraded.cursor)?.tags).toBeDefined();
    expect((await sync(upgraded.cursor)).tags).toEqual([]);

    const dropped = await sync(upgraded.cursor, false);
    expect(dropped).not.toHaveProperty("tags");
    expect(decodeSyncCursor(dropped.cursor)?.tags).toBeUndefined();
  });

  it("消したタグの行は 30 日たつと片付けで消え、それより古いタグのカーソルは invalid_cursor", async () => {
    let now = new Date("2026-11-01T00:00:00Z");
    const { platform, created, remove, sync, request } = await setup({ now: () => now });
    const tag = await created({ name: "消すタグ" });
    const before = await sync();
    expect((await remove(tag.id)).status).toBe(204);
    const current = await sync(before.cursor);
    expect(current.tags).toEqual([{ id: tag.id, deleted: true }]);

    // 消してからちょうど 30 日は残し、それを過ぎたら消す
    now = new Date("2026-12-01T00:00:00Z");
    expect(await runCleanUp(platform)).toMatchObject({ tags: 0 });
    now = new Date("2026-12-01T00:00:00.001Z");
    expect(await runCleanUp(platform)).toMatchObject({ tags: 1 });
    expect(
      await testDb.prepare("SELECT count(*) AS n FROM tags WHERE id = ?").bind(tag.id).first("n"),
    ).toBe(0);
    expect((await remove(tag.id)).status).toBe(404);

    const expired = await request(`/sync?includeTags=true&cursor=${before.cursor}`);
    expect(expired.status).toBe(400);
    expect(await expired.json()).toMatchObject({ error: { code: "invalid_cursor" } });
    // タグを受け取らないクライアントには、関係がない
    expect((await request(`/sync?cursor=${before.cursor}`)).status).toBe(200);
    // 回収したあとのカーソルは、そのまま続けられる
    expect((await sync(current.cursor)).tags).toEqual([]);
  });
});
