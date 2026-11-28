import { describe, expect, it } from "vitest";
import { runCleanUp } from "../../src/jobs/clean-up";
import { runFetchFeed } from "../../src/jobs/fetch-feed";
import type { Platform } from "../../src/platform";
import { testDb } from "../db";
import {
  createTestPlatform,
  createUser,
  fakeFetch,
  requestApp,
  statementHook,
  uniqueUrl,
} from "../helpers";

/*
 * 記事のタグの手の付け外し・取り消しと差分同期（docs/decisions/tags.md の 5〜8）。本番と同じ入口（REST API、
 * 取得の仕事、同期）から呼ぶ
 */

type ArticleTag = { id: string; tagId: string; articleId: string; kind: string; on: boolean };
type SyncArticleTag = (ArticleTag & { deleted: false }) | { id: string; deleted: true };
type SyncPage = { cursor: string; hasMore: boolean; articleTags?: SyncArticleTag[] };
type ListedArticle = { id: string; tags: ArticleTag[] };

const rss = (
  count: number,
) => `<rss version="2.0"><channel><title>Blog</title><link>https://example.com/</link>
  ${Array.from({ length: count }, (_, i) => `<item><title>記事 ${i}</title><guid isPermaLink="false">g${i}</guid></item>`).join("")}
</channel></rss>`;

/** 記事が count 件あるフィードを購読して取り込んだ利用者 */
async function setup(count = 2, overrides: Partial<Platform> = {}) {
  const { fetch } = fakeFetch(() => new Response(rss(count)));
  const { platform } = createTestPlatform({ fetch, ...overrides });
  const user = await createUser();
  const c = client(platform, user.token);
  const url = uniqueUrl();
  const subscribed = await c.request("/feeds", "POST", { url });
  expect(subscribed.status).toBe(201);
  const feed = ((await subscribed.json()) as { feed: { id: string } }).feed;
  await runFetchFeed(platform, feed.id);
  const articles = await c.articles();
  expect(articles).toHaveLength(count);
  return { ...c, platform, user, feed, url, articleIds: articles.map((a) => a.id) };
}

function client(platform: Platform, token: string) {
  const request = (path: string, method = "GET", json?: unknown) =>
    requestApp(platform, `/api/v1${path}`, { method, json, token });
  const tag = async (name: string) => {
    const response = await request("/tags", "POST", { name });
    expect(response.status).toBe(201);
    return ((await response.json()) as { tag: { id: string } }).tag.id;
  };
  const put = (articleId: string, tagId: string, on: boolean) =>
    request(`/articles/${articleId}/tags/${tagId}`, "PUT", { on });
  const putOk = async (articleId: string, tagId: string, on: boolean) => {
    const response = await put(articleId, tagId, on);
    expect(response.status).toBe(200);
    return ((await response.json()) as { articleTag: ArticleTag }).articleTag;
  };
  const clear = (articleId: string, tagId: string) =>
    request(`/articles/${articleId}/tags/${tagId}`, "DELETE");
  const articles = async (query = "") => {
    const response = await request(`/articles${query}`);
    expect(response.status).toBe(200);
    return ((await response.json()) as { items: ListedArticle[] }).items;
  };
  const sync = async (cursor?: string, include = true) => {
    const query = new URLSearchParams();
    if (cursor !== undefined) query.set("cursor", cursor);
    if (include) query.set("includeTags", "true");
    const response = await request(`/sync?${query}`);
    expect(response.status).toBe(200);
    return (await response.json()) as SyncPage;
  };
  return { request, tag, put, putOk, clear, articles, sync };
}

const seqOf = async (id: string) =>
  testDb.prepare("SELECT seq FROM article_tags WHERE id = ?").bind(id).first<number>("seq");

describe("手の付け外し", () => {
  it("付け外しでき、同じ状態の再送も同じ応答で、変更番号は見える状態が変わったときだけ振る", async () => {
    const t = await setup();
    const [articleId = ""] = t.articleIds;
    const tagId = await t.tag("Rust");
    const before = await t.sync();

    const on = await t.putOk(articleId, tagId, true);
    expect(on).toMatchObject({ tagId, articleId, kind: "manual", on: true });
    const seq = await seqOf(on.id);
    expect(await t.putOk(articleId, tagId, true)).toEqual(on);
    expect(await seqOf(on.id)).toBe(seq);
    const changes = await t.sync(before.cursor);
    expect(changes.articleTags).toEqual([{ ...on, deleted: false }]);
    expect((await t.sync(changes.cursor)).articleTags).toEqual([]);

    const off = await t.putOk(articleId, tagId, false);
    expect(off).toEqual({ ...on, on: false });
    expect(await seqOf(on.id)).toBeGreaterThan(seq ?? 0);
    expect((await t.sync(changes.cursor)).articleTags).toEqual([{ ...off, deleted: false }]);
  });

  it("本人の有効なタグでないか、記事が本人の受信箱になければ、記事がないときと同じ 404", async () => {
    const owner = await setup();
    const [articleId = ""] = owner.articleIds;
    const mine = await owner.tag("Rust");
    const otherUser = await createUser();
    const other = client(owner.platform, otherUser.token);
    const theirs = await other.tag("Go");
    // ほかの人のタグ、ほかの人の受信箱にしかない記事、ない記事、消したタグ
    expect((await owner.put(articleId, theirs, true)).status).toBe(404);
    expect((await other.put(articleId, theirs, true)).status).toBe(404);
    expect((await owner.put(crypto.randomUUID(), mine, true)).status).toBe(404);
    expect((await owner.request(`/tags/${mine}`, "DELETE")).status).toBe(204);
    const missing = await owner.put(articleId, mine, true);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: { code: "not_found" } });
    expect((await owner.clear(articleId, theirs)).status).toBe(404);
    const rows = testDb.prepare("SELECT count(*) AS n FROM article_tags WHERE user_id = ?");
    expect(await rows.bind(owner.user.id).first<number>("n")).toBe(0);
  });

  it("書く文の直前に受信箱の行が消えたら、有効な行を残さずに 404", async () => {
    const t = await setup();
    const [articleId = ""] = t.articleIds;
    const tagId = await t.tag("Rust");
    const hook = statementHook(/insert into article_tags/i, async () => {
      await t.request(`/feeds/${t.feed.id}`, "DELETE");
    });
    const hooked = client({ ...t.platform, db: hook.db }, t.user.token);
    const response = await hooked.put(articleId, tagId, true);
    expect(hook.fired()).toBe(true);
    expect(response.status).toBe(404);
    expect(
      await testDb
        .prepare("SELECT count(*) AS n FROM article_tags WHERE deleted_at IS NULL AND user_id = ?")
        .bind(t.user.id)
        .first<number>("n"),
    ).toBe(0);
  });

  it("消した印の行を生き返らせる文の直前にタグが消されても、有効な行は残らない", async () => {
    const t = await setup();
    const [articleId = ""] = t.articleIds;
    const tagId = await t.tag("Rust");
    await t.putOk(articleId, tagId, true);
    expect((await t.clear(articleId, tagId)).status).toBe(204);
    const hook = statementHook(/insert into article_tags/i, async () => {
      await t.request(`/tags/${tagId}`, "DELETE");
    });
    const hooked = client({ ...t.platform, db: hook.db }, t.user.token);
    expect((await hooked.put(articleId, tagId, true)).status).toBe(404);
    expect(
      await testDb
        .prepare("SELECT count(*) AS n FROM article_tags WHERE deleted_at IS NULL AND user_id = ?")
        .bind(t.user.id)
        .first<number>("n"),
    ).toBe(0);
  });
});

describe("取り消し", () => {
  it("手で付け外しした行だけを auto に戻して消した印を付け、それ以外は何も変えずに 204", async () => {
    const t = await setup();
    const [articleId = ""] = t.articleIds;
    const tagId = await t.tag("Rust");
    // 行がないときは何も変えない
    expect((await t.clear(articleId, tagId)).status).toBe(204);
    const on = await t.putOk(articleId, tagId, true);
    const before = await t.sync();
    expect((await t.clear(articleId, tagId)).status).toBe(204);
    expect(
      await testDb
        .prepare("SELECT kind, deleted_at IS NOT NULL AS removed FROM article_tags WHERE id = ?")
        .bind(on.id)
        .first(),
    ).toEqual({ kind: "auto", removed: 1 });
    const changes = await t.sync(before.cursor);
    expect(changes.articleTags).toEqual([{ id: on.id, deleted: true }]);
    // 取り消し済みの再送は何も変えない
    const seq = await seqOf(on.id);
    expect((await t.clear(articleId, tagId)).status).toBe(204);
    expect(await seqOf(on.id)).toBe(seq);
    // もう一度付けると、同じ行が生き返る
    expect(await t.putOk(articleId, tagId, false)).toEqual({ ...on, on: false });
  });
});

describe("受信箱とタグが消えたとき", () => {
  it("受信箱の行が消えたら、その人のその記事の行だけに消した印が付く。ほかの人の行と記事の行は変えない", async () => {
    const owner = await setup();
    const [first = "", second = ""] = owner.articleIds;
    const otherUser = await createUser();
    const other = client(owner.platform, otherUser.token);
    expect((await other.request("/feeds", "POST", { url: owner.url })).status).toBe(201);
    const mine = await owner.tag("Rust");
    const theirs = await other.tag("Rust");
    const a = await owner.putOk(first, mine, true);
    const b = await owner.putOk(second, mine, true);
    const c = await other.putOk(first, theirs, true);
    const before = await owner.sync();

    // 購読をやめると、スターのない受信箱の行が消える
    expect((await owner.request(`/feeds/${owner.feed.id}`, "DELETE")).status).toBe(204);
    const changes = await owner.sync(before.cursor);
    expect(changes.articleTags?.map((tag) => tag.id).sort()).toEqual([a.id, b.id].sort());
    expect(changes.articleTags?.every((tag) => tag.deleted)).toBe(true);
    expect(
      await testDb
        .prepare("SELECT deleted_at FROM article_tags WHERE id = ?")
        .bind(c.id)
        .first("deleted_at"),
    ).toBeNull();
    expect(
      await testDb
        .prepare("SELECT count(*) AS n FROM articles WHERE id = ?")
        .bind(first)
        .first("n"),
    ).toBe(1);
  });

  it("タグを消すと、そのタグの行に消した印と新しい変更番号が付く", async () => {
    const t = await setup();
    const [first = "", second = ""] = t.articleIds;
    const rust = await t.tag("Rust");
    const go = await t.tag("Go");
    const a = await t.putOk(first, rust, true);
    const b = await t.putOk(second, rust, false);
    const kept = await t.putOk(first, go, true);
    const before = await t.sync();
    expect((await t.request(`/tags/${rust}`, "DELETE")).status).toBe(204);
    const changes = await t.sync(before.cursor);
    expect(changes.articleTags).toEqual(
      expect.arrayContaining([
        { id: a.id, deleted: true },
        { id: b.id, deleted: true },
      ]),
    );
    expect(changes.articleTags).toHaveLength(2);
    expect((await t.articles()).find((x) => x.id === first)?.tags).toEqual([kept]);
  });
});

describe("記事の一覧と差分同期", () => {
  it("GET /articles?tagId は付いている記事だけを返し、記事の項目には手で外したものも含む記事のタグが付く", async () => {
    const t = await setup(3);
    const [first = "", second = "", third = ""] = t.articleIds;
    const rust = await t.tag("Rust");
    const on = await t.putOk(first, rust, true);
    const off = await t.putOk(second, rust, false);
    const listed = await t.articles(`?tagId=${rust}`);
    expect(listed.map((a) => a.id)).toEqual([first]);
    expect(listed[0]?.tags).toEqual([on]);
    const all = await t.articles();
    expect(all.find((a) => a.id === second)?.tags).toEqual([off]);
    expect(all.find((a) => a.id === third)?.tags).toEqual([]);

    const other = client(t.platform, (await createUser()).token);
    const theirs = await other.tag("Go");
    expect((await t.request(`/articles?tagId=${theirs}`)).status).toBe(404);
    expect((await t.request(`/articles?tagId=${crypto.randomUUID()}`)).status).toBe(404);
  });

  it("最初の同期は受信箱の最初の同期と同じ範囲の記事の分だけを送り、差分は範囲によらず送る", async () => {
    const t = await setup(2);
    const [recent = "", old = ""] = t.articleIds;
    const rust = await t.tag("Rust");
    const a = await t.putOk(recent, rust, true);
    const b = await t.putOk(old, rust, true);
    // old は既読でスターがなく、受信箱に入ってから 30 日を過ぎた記事にする
    await testDb
      .prepare(
        "UPDATE user_articles SET read_at = 1, created_at = 1 WHERE user_id = ? AND article_id = ?",
      )
      .bind(t.user.id, old)
      .run();
    const initial = await t.sync();
    expect(initial.articleTags).toEqual([{ ...a, deleted: false }]);
    const off = await t.putOk(old, rust, false);
    expect((await t.sync(initial.cursor)).articleTags).toEqual([{ ...off, deleted: false }]);
    expect(b.id).toBe(off.id);
  });

  it("消した印の行は 30 日たつと片付けで消え、それより古いカーソルは invalid_cursor", async () => {
    let now = new Date("2026-11-01T00:00:00Z");
    const t = await setup(1, { now: () => now });
    const [articleId = ""] = t.articleIds;
    const rust = await t.tag("Rust");
    const on = await t.putOk(articleId, rust, true);
    const before = await t.sync();
    // 手直しの取り消しの消した印は DB の時計で付くので、時刻を直して 30 日の境目を決める
    expect((await t.clear(articleId, rust)).status).toBe(204);
    await testDb
      .prepare("UPDATE article_tags SET deleted_at = ? WHERE id = ?")
      .bind(new Date("2026-11-01T00:00:00Z").getTime(), on.id)
      .run();
    const current = await t.sync(before.cursor);
    expect(current.articleTags).toEqual([{ id: on.id, deleted: true }]);

    now = new Date("2026-12-01T00:00:00Z");
    expect(await runCleanUp(t.platform)).toMatchObject({ articleTags: 0 });
    now = new Date("2026-12-01T00:00:00.001Z");
    expect(await runCleanUp(t.platform)).toMatchObject({ articleTags: 1 });
    const expired = await t.request(`/sync?includeTags=true&cursor=${before.cursor}`);
    expect(expired.status).toBe(400);
    expect(await expired.json()).toMatchObject({ error: { code: "invalid_cursor" } });
    expect((await t.request(`/sync?cursor=${before.cursor}`)).status).toBe(200);
    expect((await t.sync(current.cursor)).articleTags).toEqual([]);
  });
});

describe("同じ番号と片付けの量", () => {
  it("タグを消して同じ番号になった 501 行以上の消した印も、ページが切れても重ねず漏らさず届く", async () => {
    const t = await setup(1);
    const [articleId = ""] = t.articleIds;
    const rust = await t.tag("Rust");
    await t.putOk(articleId, rust, true);
    // 501 行を作るのは手間がかかるので、行を直接入れる（同じタグの行は記事ごとに 1 つ）
    const values = Array.from(
      { length: 600 },
      (_, i) =>
        `('${crypto.randomUUID()}', '${rust}', '${t.user.id}', 'x${i}', 'auto', 1, ${i + 1})`,
    ).join(",");
    await testDb.exec(
      `INSERT INTO article_tags (id, tag_id, user_id, article_id, kind, "on", seq) VALUES ${values}`,
    );
    const before = await t.sync();
    let cursor = before.cursor;
    for (let page = before; page.hasMore; cursor = page.cursor) page = await t.sync(page.cursor);
    expect((await t.request(`/tags/${rust}`, "DELETE")).status).toBe(204);
    expect(
      await testDb
        .prepare("SELECT count(DISTINCT seq) AS n FROM article_tags WHERE tag_id = ?")
        .bind(rust)
        .first<number>("n"),
    ).toBe(1);
    const seen: string[] = [];
    let pages = 0;
    for (;;) {
      const page = await t.sync(cursor);
      seen.push(...(page.articleTags ?? []).map((tag) => tag.id));
      cursor = page.cursor;
      pages++;
      if (!page.hasMore) break;
    }
    expect(pages).toBeGreaterThan(1);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toHaveLength(601);
  });

  it("消したタグの片付けは、記事のタグの行が残るうちはタグを消さず、記事のタグを先に片付ける", async () => {
    let now = new Date("2026-11-01T00:00:00Z");
    const t = await setup(2, { now: () => now });
    const [first = "", second = ""] = t.articleIds;
    const rust = await t.tag("Rust");
    await t.putOk(first, rust, true);
    await t.putOk(second, rust, false);
    expect((await t.request(`/tags/${rust}`, "DELETE")).status).toBe(204);
    now = new Date("2026-12-02T00:00:00Z");
    const outcome = await runCleanUp(t.platform);
    // 記事のタグの片付けが先に 2 行を消し、残っていないのでタグも消える
    expect(outcome).toMatchObject({ articleTags: 2, tags: 1 });
  });
});

describe("片付けが 1 日で消し切れないとき", () => {
  it("記事のタグが残る間は消したタグを消さず、記事のタグを消し切った日にタグも消す", async () => {
    let now = new Date("2026-11-01T00:00:00Z");
    const t = await setup(1, { now: () => now });
    const rust = await t.tag("Rust");
    // 1 日の片付け（500 行 × 3 回）で消し切れない数の行を、直接入れる
    const values = Array.from(
      { length: 1_600 },
      (_, i) =>
        `('${crypto.randomUUID()}', '${rust}', '${t.user.id}', 'y${i}', 'auto', 1, ${i + 1})`,
    ).join(",");
    await testDb.exec(
      `INSERT INTO article_tags (id, tag_id, user_id, article_id, kind, "on", seq) VALUES ${values}`,
    );
    expect((await t.request(`/tags/${rust}`, "DELETE")).status).toBe(204);
    now = new Date("2026-12-02T00:00:00Z");
    expect(await runCleanUp(t.platform)).toMatchObject({ articleTags: 1_500, tags: 0 });
    expect(await runCleanUp(t.platform)).toMatchObject({ articleTags: 100, tags: 1 });
  });
});

describe("容量", () => {
  it("記事のタグを保存容量に 1 行 256 バイトで数え、手の付け外しは上限でも断らない", async () => {
    const t = await setup(1);
    const [articleId = ""] = t.articleIds;
    const rust = await t.tag("Rust");
    const usage = async () =>
      (await testDb
        .prepare("SELECT bytes FROM storage_usage WHERE id = 1")
        .first<number>("bytes")) ?? 0;
    const before = await usage();
    const saved = await testDb
      .prepare("SELECT limit_bytes FROM storage_usage")
      .first<number>("limit_bytes");
    await testDb.exec("UPDATE storage_usage SET limit_bytes = 1 WHERE id = 1");
    try {
      await t.putOk(articleId, rust, true);
    } finally {
      await testDb.exec(`UPDATE storage_usage SET limit_bytes = ${saved} WHERE id = 1`);
    }
    expect((await usage()) - before).toBe(256);
  });
});
