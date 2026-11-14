import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { insertArticles } from "../../src/db/articles";
import { createFolder } from "../../src/db/folders";
import { deliverNewArticles } from "../../src/db/inbox";
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
  articles: {
    id: string;
    feedId: string;
    title: string | null;
    readAt: string | null;
    starredAt: string | null;
  }[];
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
    for (const feed of body.feeds) {
      if (feed.deleted) {
        state.feeds.delete(feed.id);
        // 購読をやめたフィードの記事は、スターの付いたものを除いて消す
        for (const [id, article] of state.articles) {
          if (article.feedId === feed.id && !article.starred) state.articles.delete(id);
        }
      } else {
        state.feeds.set(feed.id, { title: feed.title, folderId: feed.folderId });
      }
    }
    for (const article of body.articles) {
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
