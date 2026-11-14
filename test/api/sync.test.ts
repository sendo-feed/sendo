import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import { insertArticles } from "../../src/db/articles";
import { insertFeeds } from "../../src/db/feeds";
import { createFolder } from "../../src/db/folders";
import { backfillInbox, deliverNewArticles } from "../../src/db/inbox";
import * as schema from "../../src/db/schema";
import { assignFolderIfMissing, subscribeMany } from "../../src/db/subscriptions";
import { SYNC_LIMITS } from "../../src/db/sync";
import { runFetchFeed } from "../../src/jobs/fetch-feed";
import {
  addToInbox,
  createTestPlatform,
  createUser,
  fakeFetch,
  requestApp,
  subscribeFeed,
  TEST_USER,
} from "../helpers";

type SyncResponse = {
  cursor: string;
  hasMore: boolean;
  folders: { id: string; name: string; deleted: boolean }[];
  feeds: { id: string; title: string | null; folderId: string | null; deleted: boolean }[];
  articles: (
    | {
        id: string;
        feedId: string;
        title: string | null;
        readAt: string | null;
        starredAt: string | null;
        deleted: false;
      }
    | { id: string; deleted: true }
  )[];
};

const DAY = 24 * 60 * 60 * 1000;

/** クライアントの手元の状態。差分を受け取るたびに当てる */
function createClient(platform: Parameters<typeof requestApp>[0], token?: string) {
  const state = {
    folders: new Map<string, { name: string }>(),
    feeds: new Map<string, { title: string | null; folderId: string | null }>(),
    articles: new Map<
      string,
      { feedId: string; title: string | null; read: boolean; starred: boolean }
    >(),
  };
  let cursor: string | undefined;
  let requests = 0;

  const apply = (body: SyncResponse) => {
    for (const folder of body.folders) {
      if (folder.deleted) state.folders.delete(folder.id);
      else state.folders.set(folder.id, { name: folder.name });
    }
    // 手元の行を消すのは、その行の deleted が届いたときだけ（docs/decisions/sync.md の 3）。
    // 購読をやめても、そのフィードの記事は消さない
    for (const feed of body.feeds) {
      if (feed.deleted) state.feeds.delete(feed.id);
      else state.feeds.set(feed.id, { title: feed.title, folderId: feed.folderId });
    }
    for (const article of body.articles) {
      if (article.deleted) {
        state.articles.delete(article.id);
        continue;
      }
      state.articles.set(article.id, {
        feedId: article.feedId,
        title: article.title,
        read: article.readAt !== null,
        starred: article.starredAt !== null,
      });
    }
  };

  /** 1 回だけ同期する（1 ページ分） */
  const step = async () => {
    const query = cursor === undefined ? "" : `?cursor=${cursor}`;
    const res = await requestApp(platform, `/api/v1/sync${query}`, token ? { token } : {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as SyncResponse;
    requests++;
    apply(body);
    cursor = body.cursor;
    return body;
  };

  /** hasMore が false になるまで同期する */
  const sync = async () => {
    for (let i = 0; i < 50; i++) {
      const body = await step();
      if (!body.hasMore) return body;
    }
    throw new Error("sync did not finish");
  };

  return { state, step, sync, cursor: () => cursor, requests: () => requests };
}

/** 記事を共有の表に入れて、受信箱に入った時刻を決めて受信箱に入れる */
async function seedArticles(
  platform: ReturnType<typeof createTestPlatform>["platform"],
  feedId: string,
  rows: { id: string; receivedAt: Date; read?: boolean; starred?: boolean }[],
) {
  await insertArticles(
    platform.db,
    rows.map((row) => ({
      id: row.id,
      feedId,
      guid: row.id,
      url: null,
      title: row.id,
      summary: null,
      author: null,
      publishedAt: row.receivedAt,
      createdAt: row.receivedAt,
    })),
  );
  await addToInbox(
    platform,
    rows.map((row) => ({
      articleId: row.id,
      feedId,
      publishedAt: row.receivedAt,
      receivedAt: row.receivedAt,
    })),
  );
  for (const row of rows) {
    if (!row.read && !row.starred) continue;
    await env.DB.prepare(
      "UPDATE user_articles SET read_at = ?, starred_at = ? WHERE user_id = ? AND article_id = ?",
    )
      .bind(row.read ? 1 : null, row.starred ? 1 : null, TEST_USER.id, row.id)
      .run();
  }
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM feeds");
  await env.DB.exec("DELETE FROM folders");
});

describe("最初の同期", () => {
  it("消した印の付いていないフォルダと購読、未読・スター・直近 30 日の記事だけを返す", async () => {
    const { platform } = createTestPlatform();
    const now = Date.now();
    const tech = await createFolder(platform.db, {
      userId: TEST_USER.id,
      id: "tech",
      name: "Tech",
      now: new Date(),
    });
    await createFolder(platform.db, {
      userId: TEST_USER.id,
      id: "gone",
      name: "Gone",
      now: new Date(),
    });
    await requestApp(platform, "/api/v1/folders/gone", { method: "DELETE" });
    const a = await subscribeFeed(platform, { feedId: "a", folderId: tech.id });
    await subscribeFeed(platform, { feedId: "b" });
    await seedArticles(platform, a.id, [
      { id: "unread-old", receivedAt: new Date(now - 90 * DAY) },
      { id: "read-recent", receivedAt: new Date(now - 1 * DAY), read: true },
      { id: "read-old", receivedAt: new Date(now - 90 * DAY), read: true },
      { id: "starred-old", receivedAt: new Date(now - 90 * DAY), read: true, starred: true },
    ]);

    const client = createClient(platform);
    await client.sync();

    expect([...client.state.folders.keys()]).toEqual(["tech"]);
    expect([...client.state.feeds.keys()].sort()).toEqual(["a", "b"]);
    expect(client.state.feeds.get("a")?.folderId).toBe("tech");
    expect([...client.state.articles.keys()].sort()).toEqual([
      "read-recent",
      "starred-old",
      "unread-old",
    ]);
  });

  it("ページを送る間に変わった記事も、最後には正しい状態になる", async () => {
    const { platform } = createTestPlatform();
    const feed = await subscribeFeed(platform, {});
    const old = Date.now() - 90 * DAY;
    // 古い未読の記事を、1 ページに収まらない数だけ入れる
    const count = SYNC_LIMITS.articles + 20;
    await seedArticles(
      platform,
      feed.id,
      Array.from({ length: count }, (_, i) => ({
        id: `x${String(i).padStart(4, "0")}`,
        receivedAt: new Date(old + i),
      })),
    );
    const client = createClient(platform);

    // 1 ページ目だけ取る
    const first = await client.step();
    expect(first.hasMore).toBe(true);
    // 1 ページ目で届いた古い記事が、ほかの端末で既読になった（もう最初の同期の範囲外）
    const sent = first.articles[0]?.id ?? "";
    await requestApp(platform, `/api/v1/articles/${sent}`, {
      method: "PATCH",
      json: { read: true },
    });

    await client.sync();

    expect(client.state.articles.size).toBe(count);
    expect(client.state.articles.get(sent)?.read).toBe(true);
  });
});

describe("差分", () => {
  it("あとからの変更（既読、新着、フォルダの名前の変更と削除、購読をやめる）だけが届く", async () => {
    const site = fakeFetch(
      () =>
        new Response(
          `<rss version="2.0"><channel><title>Renamed</title>
            <item><title>n</title><link>https://a.example/new</link><guid>new</guid></item>
          </channel></rss>`,
        ),
    );
    const { platform } = createTestPlatform({ fetch: site.fetch });
    const tech = await createFolder(platform.db, {
      userId: TEST_USER.id,
      id: "tech",
      name: "Tech",
      now: new Date(),
    });
    const a = await subscribeFeed(platform, { feedId: "a", folderId: tech.id });
    const b = await subscribeFeed(platform, { feedId: "b" });
    const recent = new Date(Date.now() - 1000);
    await seedArticles(platform, a.id, [{ id: "a1", receivedAt: recent }]);
    await seedArticles(platform, b.id, [
      { id: "b1", receivedAt: recent },
      { id: "b2", receivedAt: recent },
    ]);
    const client = createClient(platform);
    await client.sync();
    await requestApp(platform, "/api/v1/articles/b2", { method: "PATCH", json: { starred: true } });
    await client.sync();

    // 変更：既読、新着（フィード a の名前も変わる）、フォルダの名前の変更、購読をやめる、フォルダの削除
    await requestApp(platform, "/api/v1/articles/a1", { method: "PATCH", json: { read: true } });
    await runFetchFeed(platform, a.id);
    await requestApp(platform, "/api/v1/folders/tech", { method: "PATCH", json: { name: "技術" } });
    await requestApp(platform, `/api/v1/feeds/${b.id}`, { method: "DELETE" });
    const before = client.requests();
    const delta = await client.sync();

    expect(client.requests() - before).toBe(1);
    expect(client.state.articles.get("a1")?.read).toBe(true);
    expect([...client.state.articles.values()].map((article) => article.title).sort()).toEqual([
      "a1",
      "b2",
      "n",
    ]);
    expect(client.state.feeds.get("a")?.title).toBe("Renamed");
    expect(client.state.feeds.has("b")).toBe(false);
    expect(client.state.folders.get("tech")?.name).toBe("技術");
    expect(delta.feeds.find((feed) => feed.id === "b")?.deleted).toBe(true);

    await requestApp(platform, "/api/v1/folders/tech", { method: "DELETE" });
    await client.sync();
    expect(client.state.folders.size).toBe(0);
    expect(client.state.feeds.get("a")?.folderId).toBeNull();

    // 何も変わっていなければ、空で返る
    const empty = await client.sync();
    expect([empty.folders, empty.feeds, empty.articles]).toEqual([[], [], []]);
  });

  it("同じ文で変えた（同じ番号の）行がページの境目をまたいでも、取りこぼさない", async () => {
    const { platform } = createTestPlatform();
    const feed = await subscribeFeed(platform, {});
    const recent = new Date(Date.now() - 1000);
    const count = SYNC_LIMITS.articles * 2 + 7;
    await seedArticles(
      platform,
      feed.id,
      Array.from({ length: count }, (_, i) => ({ id: `y${i}`, receivedAt: recent })),
    );
    const client = createClient(platform);
    await client.sync();
    const list = (await (await requestApp(platform, "/api/v1/articles?limit=1")).json()) as {
      asOf: string;
    };

    // すべてを 1 つの文で既読にする（すべて同じ番号になる）
    await requestApp(platform, "/api/v1/articles/mark-read", {
      method: "POST",
      json: { all: true, until: new Date(Date.parse(list.asOf) + 1).toISOString() },
    });
    await client.sync();

    expect([...client.state.articles.values()].every((article) => article.read)).toBe(true);
    expect(client.state.articles.size).toBe(count);
  });

  it("フィードの名前を保存するだけで、購読の番号が進み、同期で届く（#25 のレビュー）", async () => {
    const { platform } = createTestPlatform();
    const feed = await subscribeFeed(platform, {});
    const client = createClient(platform);
    await client.sync();

    // コードで購読の番号を進めなくても、トリガーが進める（途中で落ちても伝え漏れがない）
    await env.DB.prepare("UPDATE feeds SET title = ? WHERE id = ?").bind("New name", feed.id).run();
    await client.sync();
    expect(client.state.feeds.get(feed.id)?.title).toBe("New name");

    // 名前が変わらない更新では、番号は進まない
    await env.DB.prepare("UPDATE feeds SET title = ?, etag = ? WHERE id = ?")
      .bind("New name", "x", feed.id)
      .run();
    const empty = await client.sync();
    expect(empty.feeds).toEqual([]);
  });

  it("購読し直したあとに元のフォルダを消しても、今の購読は手元から消えない（#25 のレビュー）", async () => {
    const { platform } = createTestPlatform();
    const tech = await createFolder(platform.db, {
      userId: TEST_USER.id,
      id: "tech",
      name: "Tech",
      now: new Date(),
    });
    const feed = await subscribeFeed(platform, { folderId: tech.id });
    const client = createClient(platform);
    await client.sync();

    // フォルダに入れたまま購読をやめ、フォルダなしで購読し直す
    await requestApp(platform, `/api/v1/feeds/${feed.id}`, { method: "DELETE" });
    await subscribeMany(platform.db, {
      userId: TEST_USER.id,
      rows: [{ feedId: feed.id, folderId: null }],
      now: new Date(),
    });
    await client.sync();
    expect(client.state.feeds.get(feed.id)?.folderId).toBeNull();

    // 元のフォルダを消す（古い購読の行も、まだそのフォルダを指している）
    const oldRow = () =>
      env.DB.prepare(
        "SELECT seq, folder_id FROM subscriptions WHERE feed_id = ? AND deleted_at IS NOT NULL",
      )
        .bind(feed.id)
        .first<{ seq: number; folder_id: string | null }>();
    const before = await oldRow();
    await requestApp(platform, `/api/v1/folders/${tech.id}`, { method: "DELETE" });
    // 古い行はフォルダを指さなくなるが、番号は進まない
    expect(await oldRow()).toEqual({ seq: before?.seq, folder_id: null });
    await client.sync();

    expect(client.state.feeds.has(feed.id)).toBe(true);
    expect(client.state.folders.has(tech.id)).toBe(false);
  });

  it("同じフィードに今の購読があれば、古い購読の消した印は送らない", async () => {
    const { platform } = createTestPlatform();
    const feed = await subscribeFeed(platform, {});
    await requestApp(platform, `/api/v1/feeds/${feed.id}`, { method: "DELETE" });
    await subscribeMany(platform.db, {
      userId: TEST_USER.id,
      rows: [{ feedId: feed.id, folderId: null }],
      now: new Date(),
    });
    const client = createClient(platform);
    await client.sync();

    // どの経路であれ、古い購読の番号があとから進んだ場合
    await env.DB.prepare(
      "UPDATE subscriptions SET seq = (SELECT max(seq) FROM subscriptions) + 1 WHERE feed_id = ? AND deleted_at IS NOT NULL",
    )
      .bind(feed.id)
      .run();
    const delta = await client.sync();

    expect(delta.feeds).toEqual([]);
    expect(client.state.feeds.has(feed.id)).toBe(true);
  });

  it("ほかの人の変更は届かない", async () => {
    const { platform } = createTestPlatform();
    const other = await createUser();
    await subscribeFeed(platform, { userId: other.id });
    await createFolder(platform.db, { userId: other.id, id: "x", name: "X", now: new Date() });

    const client = createClient(platform);
    await client.sync();

    expect(client.state.feeds.size).toBe(0);
    expect(client.state.folders.size).toBe(0);
  });

  it("読めないカーソルは 400（最初から同期し直す）", async () => {
    const { platform } = createTestPlatform();
    for (const cursor of ["broken", btoa(JSON.stringify({ v: 999 }))]) {
      const res = await requestApp(platform, `/api/v1/sync?cursor=${cursor}`);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: { code: "invalid_cursor" } });
    }
  });
});

/**
 * pattern に合う SELECT を実行する直前に、一度だけ before を走らせる D1（arm したあとの 1 回だけ）。
 * 1 回の同期の中で、文と文の間にほかの書き込みが入る場合を作る
 */
function d1WithHook(pattern: RegExp, before: () => Promise<void>) {
  let armed = false;
  const wrap = (stmt: D1PreparedStatement, query: string): D1PreparedStatement =>
    new Proxy(stmt, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target);
        if (typeof value !== "function") return value;
        if (prop === "bind") {
          return (...args: unknown[]) => wrap(value.apply(target, args), query);
        }
        if (prop === "all" || prop === "raw" || prop === "first" || prop === "run") {
          return async (...args: unknown[]) => {
            if (armed && /^\s*select/i.test(query) && pattern.test(query)) {
              armed = false;
              await before();
            }
            return value.apply(target, args);
          };
        }
        return value.bind(target);
      },
    });
  const db = new Proxy(env.DB, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (prop === "prepare") return (query: string) => wrap(target.prepare(query), query);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return {
    db,
    arm: () => {
      armed = true;
    },
  };
}

describe("受信箱から消えた記事", () => {
  it("記事の差分を読む間に新着と削除が入っても、新着を取りこぼさない（#25 のレビュー）", async () => {
    const { platform: plain } = createTestPlatform();
    const feed = await subscribeFeed(plain, {});
    const recent = new Date(Date.now() - 1000);
    await seedArticles(plain, feed.id, [{ id: "r", receivedAt: recent }]);
    await insertArticles(plain.db, [
      {
        id: "n",
        feedId: feed.id,
        guid: "n",
        url: null,
        title: "n",
        summary: null,
        author: null,
        publishedAt: recent,
        createdAt: recent,
      },
    ]);
    // 消した記録を読む文の直前に、新着（n）を配り、別の記事（r）を受信箱から消す
    const hooked = d1WithHook(/user_article_removals/, async () => {
      await deliverNewArticles(plain.db, { feedId: feed.id });
      await env.DB.prepare("DELETE FROM user_articles WHERE article_id = 'r'").run();
    });
    const { platform } = createTestPlatform({ db: drizzle(hooked.db, { schema }) });
    const client = createClient(platform);
    await client.sync();
    expect([...client.state.articles.keys()]).toEqual(["r"]);

    hooked.arm();
    await client.sync();

    expect([...client.state.articles.keys()]).toEqual(["n"]);
  });

  it("スターを外してから購読をやめても、消えた記録が届いて手元から消える（#25 のレビュー）", async () => {
    const { platform } = createTestPlatform();
    const feed = await subscribeFeed(platform, {});
    const recent = new Date(Date.now() - 1000);
    await seedArticles(platform, feed.id, [{ id: "s", receivedAt: recent, starred: true }]);
    const client = createClient(platform);
    await client.sync();
    expect(client.state.articles.get("s")?.starred).toBe(true);

    // 次の同期までに、スターを外して購読をやめる（受信箱の行が消え、スターを外した変更は届かない）
    await requestApp(platform, "/api/v1/articles/s", { method: "PATCH", json: { starred: false } });
    await requestApp(platform, `/api/v1/feeds/${feed.id}`, { method: "DELETE" });
    const delta = await client.sync();

    expect(delta.articles).toEqual([{ id: "s", deleted: true }]);
    expect(client.state.articles.has("s")).toBe(false);
    expect(client.state.feeds.has(feed.id)).toBe(false);
  });

  it("購読の変更が 1 ページに収まらないときに購読し直しても、入れ直した記事は手元に残る", async () => {
    const { platform } = createTestPlatform();
    const now = new Date();
    const feed = await subscribeFeed(platform, { feedId: "f" });
    await seedArticles(platform, feed.id, [
      { id: "x", receivedAt: new Date(now.getTime() - 1000) },
    ]);
    const others = Array.from({ length: SYNC_LIMITS.subscriptions }, (_, i) => `o${i}`);
    await insertFeeds(
      platform.db,
      others.map((id) => ({
        id,
        url: `https://${id}.example/feed`,
        nextFetchAt: now,
        createdAt: now,
      })),
    );
    await subscribeMany(platform.db, {
      userId: TEST_USER.id,
      rows: others.map((feedId) => ({ feedId, folderId: null })),
      now,
    });
    const client = createClient(platform);
    await client.sync();

    // 別の端末で：1 ページに収まらない数の購読をフォルダに入れ、f をやめて、もう一度購読する。
    // 入れ直した x は記事のほうで先に届き、「f をやめた」は購読のほうで次のページに届く
    const folder = await createFolder(platform.db, {
      userId: TEST_USER.id,
      id: "imported",
      name: "Imported",
      now,
    });
    await assignFolderIfMissing(platform.db, {
      userId: TEST_USER.id,
      folderId: folder.id,
      feedIds: others,
    });
    await requestApp(platform, `/api/v1/feeds/${feed.id}`, { method: "DELETE" });
    await subscribeMany(platform.db, {
      userId: TEST_USER.id,
      rows: [{ feedId: feed.id, folderId: null }],
      now,
    });
    await backfillInbox(platform.db, { userId: TEST_USER.id, feedIds: [feed.id], now });
    await client.sync();

    expect(client.state.feeds.has(feed.id)).toBe(true);
    expect(client.state.articles.has("x")).toBe(true);
  });

  it("最初の同期では、消えた記録を送らない", async () => {
    const { platform } = createTestPlatform();
    const gone = await subscribeFeed(platform, {});
    const kept = await subscribeFeed(platform, {});
    const recent = new Date(Date.now() - 1000);
    await seedArticles(platform, gone.id, [{ id: "g1", receivedAt: recent }]);
    await seedArticles(platform, kept.id, [{ id: "k1", receivedAt: recent }]);
    await requestApp(platform, `/api/v1/feeds/${gone.id}`, { method: "DELETE" });

    const first = (await (await requestApp(platform, "/api/v1/sync")).json()) as SyncResponse;

    expect(first.articles.map((article) => [article.id, article.deleted])).toEqual([["k1", false]]);
  });

  it("最初の同期の途中で消えた記事も、最後には手元から消える", async () => {
    const { platform } = createTestPlatform();
    const feed = await subscribeFeed(platform, {});
    const recent = new Date(Date.now() - 1000);
    await seedArticles(
      platform,
      feed.id,
      Array.from({ length: SYNC_LIMITS.articles + 20 }, (_, i) => ({
        id: `p${String(i).padStart(4, "0")}`,
        receivedAt: recent,
      })),
    );
    const client = createClient(platform);

    // 1 ページ目だけ取ったところで、購読をやめる（1 ページ目で届いた記事も受信箱から消える）
    expect((await client.step()).hasMore).toBe(true);
    await requestApp(platform, `/api/v1/feeds/${feed.id}`, { method: "DELETE" });
    await client.sync();

    expect(client.state.articles.size).toBe(0);
    expect(client.state.feeds.size).toBe(0);
  });
});

describe("まとめて既読の境界にカーソルを使う", () => {
  it("同期で手元に届いた記事だけを既読にし、そのあとに届いた記事は未読のまま残す", async () => {
    const { platform } = createTestPlatform();
    const feed = await subscribeFeed(platform, {});
    const recent = new Date(Date.now() - 1000);
    await seedArticles(platform, feed.id, [
      { id: "seen1", receivedAt: recent },
      { id: "seen2", receivedAt: recent },
    ]);
    const client = createClient(platform);
    await client.sync();

    // 同期のあとに新着が届いた
    await insertArticles(platform.db, [
      {
        id: "later",
        feedId: feed.id,
        guid: "later",
        url: null,
        title: "later",
        summary: null,
        author: null,
        publishedAt: recent,
        createdAt: recent,
      },
    ]);
    await deliverNewArticles(platform.db, { feedId: feed.id });

    const res = await requestApp(platform, "/api/v1/articles/mark-read", {
      method: "POST",
      json: { all: true, cursor: client.cursor() },
    });

    expect(await res.json()).toEqual({ updated: 2 });
    await client.sync();
    expect(client.state.articles.get("later")?.read).toBe(false);
    expect(client.state.articles.get("seen1")?.read).toBe(true);
  });

  it("同期のあとにスターを付けた（番号の進んだ）記事も、手元に届いていれば既読にする（#25 のレビュー）", async () => {
    const { platform } = createTestPlatform();
    const feed = await subscribeFeed(platform, {});
    const recent = new Date(Date.now() - 1000);
    await seedArticles(platform, feed.id, [
      { id: "s1", receivedAt: recent },
      { id: "s2", receivedAt: recent },
    ]);
    const client = createClient(platform);
    await client.sync();
    await requestApp(platform, "/api/v1/articles/s1", { method: "PATCH", json: { starred: true } });

    const res = await requestApp(platform, "/api/v1/articles/mark-read", {
      method: "POST",
      json: { all: true, cursor: client.cursor() },
    });

    expect(await res.json()).toEqual({ updated: 2 });
  });

  it("最初の同期で送らなかった古い既読の記事を、ほかの端末で未読に戻しても、既読にしない（#25 のレビュー）", async () => {
    const { platform } = createTestPlatform();
    const feed = await subscribeFeed(platform, {});
    await seedArticles(platform, feed.id, [
      { id: "old", receivedAt: new Date(Date.now() - 90 * DAY), read: true },
      { id: "new", receivedAt: new Date(Date.now() - 1000) },
    ]);
    const client = createClient(platform);
    await client.sync();
    expect(client.state.articles.has("old")).toBe(false);

    // ほかの端末で未読に戻した。この端末はまだ同期していない
    await requestApp(platform, "/api/v1/articles/old", { method: "PATCH", json: { read: false } });
    const res = await requestApp(platform, "/api/v1/articles/mark-read", {
      method: "POST",
      json: { all: true, cursor: client.cursor() },
    });

    expect(await res.json()).toEqual({ updated: 1 });
    await client.sync();
    expect(client.state.articles.get("old")?.read).toBe(false);
    expect(client.state.articles.get("new")?.read).toBe(true);
  });

  it("既読として手元に届いた記事を、ほかの端末で未読に戻しても、既読にしない", async () => {
    const { platform } = createTestPlatform();
    const feed = await subscribeFeed(platform, {});
    const recent = new Date(Date.now() - 1000);
    await seedArticles(platform, feed.id, [
      { id: "was-read", receivedAt: recent, read: true },
      { id: "unread", receivedAt: recent },
    ]);
    const client = createClient(platform);
    await client.sync();
    expect(client.state.articles.get("was-read")?.read).toBe(true);

    await requestApp(platform, "/api/v1/articles/was-read", {
      method: "PATCH",
      json: { read: false },
    });
    const res = await requestApp(platform, "/api/v1/articles/mark-read", {
      method: "POST",
      json: { all: true, cursor: client.cursor() },
    });

    expect(await res.json()).toEqual({ updated: 1 });
    await client.sync();
    expect(client.state.articles.get("was-read")?.read).toBe(false);
  });

  it("未読のまま手元に届いた記事は、未読の操作が送り直されても既読にする", async () => {
    const { platform } = createTestPlatform();
    const feed = await subscribeFeed(platform, {});
    await seedArticles(platform, feed.id, [{ id: "u", receivedAt: new Date(Date.now() - 1000) }]);
    const client = createClient(platform);
    await client.sync();

    // すでに未読なので、既読・未読は変わらない（操作キューの送り直しなど）
    await requestApp(platform, "/api/v1/articles/u", { method: "PATCH", json: { read: false } });
    const res = await requestApp(platform, "/api/v1/articles/mark-read", {
      method: "POST",
      json: { all: true, cursor: client.cursor() },
    });

    expect(await res.json()).toEqual({ updated: 1 });
  });

  it("送り切っていない（hasMore が true の）応答のカーソルは 400。送り切れば使える（#25 のレビュー）", async () => {
    const { platform } = createTestPlatform();
    const feed = await subscribeFeed(platform, {});
    const recent = Date.now() - 1000;
    const count = SYNC_LIMITS.articles + 1;
    await seedArticles(
      platform,
      feed.id,
      Array.from({ length: count }, (_, i) => ({
        id: `m${String(i).padStart(4, "0")}`,
        receivedAt: new Date(recent + i),
      })),
    );
    // 最初に受信箱に入った記事にスターを付ける（番号が末尾に移り、1 ページ目には入らない）
    await requestApp(platform, "/api/v1/articles/m0000", {
      method: "PATCH",
      json: { starred: true },
    });
    const client = createClient(platform);
    expect((await client.step()).hasMore).toBe(true);
    expect(client.state.articles.has("m0000")).toBe(false);

    const early = await requestApp(platform, "/api/v1/articles/mark-read", {
      method: "POST",
      json: { all: true, cursor: client.cursor() },
    });
    expect(early.status).toBe(400);
    expect(await early.json()).toMatchObject({ error: { code: "sync_incomplete" } });

    await client.sync();
    const done = await requestApp(platform, "/api/v1/articles/mark-read", {
      method: "POST",
      json: { all: true, cursor: client.cursor() },
    });
    expect(await done.json()).toEqual({ updated: count });
  });

  it("until と cursor の両方、またはどちらもなければ 400", async () => {
    const { platform } = createTestPlatform();
    for (const json of [
      { all: true },
      { all: true, until: new Date().toISOString(), cursor: "x" },
    ]) {
      const res = await requestApp(platform, "/api/v1/articles/mark-read", {
        method: "POST",
        json,
      });
      expect(res.status).toBe(400);
    }
  });
});
