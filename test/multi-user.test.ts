import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { insertArticles } from "../src/db/articles";
import { backfillInbox, deliverNewArticles, insertRecentArticles } from "../src/db/inbox";
import { subscribeMany, unsubscribe } from "../src/db/subscriptions";
import { runFetchFeed } from "../src/jobs/fetch-feed";
import { createTestPlatform, createUser, fakeFetch, requestApp, TEST_USER } from "./helpers";

type Json = Record<string, unknown>;
const json = async (res: Response) => (await res.json()) as Json;

const RSS = `<rss version="2.0"><channel><title>Shared</title>
  <item><title>one</title><link>https://shared.example/1</link><guid>1</guid></item>
  <item><title>two</title><link>https://shared.example/2</link><guid>2</guid></item>
</channel></rss>`;

/** 2 人のユーザー（テスト用のユーザーと、もう 1 人）と、フィードを返す fetch */
async function setup() {
  const site = fakeFetch(() => new Response(RSS));
  const { platform } = createTestPlatform({ fetch: site.fetch });
  const other = await createUser();
  const as = (token?: string) => ({
    get: (path: string) => requestApp(platform, path, token ? { token } : {}),
    send: (method: string, path: string, body?: unknown) =>
      requestApp(platform, path, { method, json: body, ...(token && { token }) }),
  });
  return { platform, calls: site.calls, me: as(), other: as(other.token), otherId: other.id };
}

/** seq の列の値を読む */
async function seqOf(sql: string, ...params: unknown[]) {
  const row = await env.DB.prepare(sql)
    .bind(...params)
    .first<{ seq: number }>();
  return row?.seq;
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM feeds");
  await env.DB.exec("DELETE FROM folders");
  // 下限の行が消えていても、トリガーが作り直すことも確かめる
  await env.DB.exec("DELETE FROM seq_floors");
});

describe("人ごとのデータ", () => {
  it("購読・フォルダ・記事は、ほかの人から見えず、触れない", async () => {
    const { me, other } = await setup();
    const { folder } = (await json(await me.send("POST", "/api/v1/folders", { name: "Tech" }))) as {
      folder: { id: string };
    };
    const { feed } = (await json(
      await me.send("POST", "/api/v1/feeds", {
        url: "https://shared.example/feed",
        folderId: folder.id,
      }),
    )) as { feed: { id: string } };

    expect(await json(await other.get("/api/v1/feeds"))).toEqual({ items: [] });
    expect(await json(await other.get("/api/v1/folders"))).toEqual({ items: [] });
    expect(
      ((await json(await other.get("/api/v1/articles"))) as { items: unknown[] }).items,
    ).toEqual([]);

    // ほかの人のフォルダやフィードは、ないものとして扱う
    expect((await other.send("PATCH", `/api/v1/folders/${folder.id}`, { name: "x" })).status).toBe(
      404,
    );
    expect((await other.send("DELETE", `/api/v1/folders/${folder.id}`)).status).toBe(404);
    expect((await other.send("DELETE", `/api/v1/feeds/${feed.id}`)).status).toBe(404);
    expect(
      (
        await other.send("POST", "/api/v1/feeds", {
          url: "https://shared.example/feed",
          folderId: folder.id,
        })
      ).status,
    ).toBe(400);
  });

  it("同じフィードを 2 人が購読しても、フィードは 1 つで取得も 1 回。記事は 2 人の受信箱に入る", async () => {
    const { platform, calls, me, other } = await setup();
    const mine = (await json(
      await me.send("POST", "/api/v1/feeds", { url: "https://shared.example/feed" }),
    )) as { feed: { id: string } };
    const theirs = (await json(
      await other.send("POST", "/api/v1/feeds", { url: "https://shared.example/feed" }),
    )) as { feed: { id: string } };
    expect(theirs.feed.id).toBe(mine.feed.id);
    calls.length = 0;

    await runFetchFeed(platform, mine.feed.id);

    expect(calls).toHaveLength(1);
    const feeds = await env.DB.prepare("SELECT count(*) AS n FROM feeds").first<{ n: number }>();
    expect(feeds?.n).toBe(1);
    for (const user of [me, other]) {
      const list = (await json(await user.get("/api/v1/articles"))) as {
        items: { title: string }[];
      };
      expect(list.items.map((item) => item.title).sort()).toEqual(["one", "two"]);
    }
  });

  it("既読とスターは人ごと", async () => {
    const { platform, me, other } = await setup();
    const { feed } = (await json(
      await me.send("POST", "/api/v1/feeds", { url: "https://shared.example/feed" }),
    )) as { feed: { id: string } };
    await other.send("POST", "/api/v1/feeds", { url: "https://shared.example/feed" });
    await runFetchFeed(platform, feed.id);
    const [first] = ((await json(await me.get("/api/v1/articles"))) as { items: { id: string }[] })
      .items;

    await me.send("PATCH", `/api/v1/articles/${first?.id}`, { read: true, starred: true });

    expect(await json(await me.get("/api/v1/unread-counts"))).toMatchObject({ total: 1 });
    expect(await json(await other.get("/api/v1/unread-counts"))).toMatchObject({ total: 2 });
    const theirs = (await json(await other.get("/api/v1/articles?state=starred"))) as {
      items: unknown[];
    };
    expect(theirs.items).toEqual([]);
  });
});

describe("受信箱に配る", () => {
  it("何度配っても重複せず、配るのが途中で落ちても次に配り直せる", async () => {
    const { platform, me } = await setup();
    const { feed } = (await json(
      await me.send("POST", "/api/v1/feeds", { url: "https://shared.example/feed" }),
    )) as { feed: { id: string } };
    const past = new Date(Date.now() - 1000);
    const article = (id: string) => ({
      id,
      feedId: feed.id,
      guid: id,
      url: null,
      title: id,
      summary: null,
      author: null,
      publishedAt: past,
      createdAt: past,
    });

    // 記事を入れたが、配る前に落ちた
    await insertArticles(platform.db, [article("x1")]);
    // 次の取得で、新しい記事と一緒に配り直す
    await insertArticles(platform.db, [article("x2")]);
    await deliverNewArticles(platform.db, { feedId: feed.id });
    await deliverNewArticles(platform.db, { feedId: feed.id });

    const inbox = await env.DB.prepare(
      "SELECT article_id FROM user_articles WHERE user_id = ? ORDER BY article_id",
    )
      .bind(TEST_USER.id)
      .all<{ article_id: string }>();
    expect(inbox.results.map((row) => row.article_id)).toEqual(["x1", "x2"]);
  });

  it("購読をやめた人には配らない", async () => {
    const { platform, me, other, otherId } = await setup();
    const { feed } = (await json(
      await me.send("POST", "/api/v1/feeds", { url: "https://shared.example/feed" }),
    )) as { feed: { id: string } };
    await other.send("POST", "/api/v1/feeds", { url: "https://shared.example/feed" });
    await other.send("DELETE", `/api/v1/feeds/${feed.id}`);

    await runFetchFeed(platform, feed.id);

    const theirs = await env.DB.prepare("SELECT count(*) AS n FROM user_articles WHERE user_id = ?")
      .bind(otherId)
      .first<{ n: number }>();
    expect(theirs?.n).toBe(0);
  });
});

describe("変更番号（docs/decisions/sync.md）", () => {
  it("行を作るたび、変えるたびに、番号が大きくなる", async () => {
    const { me } = await setup();
    const created = (await json(await me.send("POST", "/api/v1/folders", { name: "A" }))) as {
      folder: { id: string };
    };
    const first = await seqOf("SELECT seq FROM folders WHERE id = ?", created.folder.id);

    await me.send("POST", "/api/v1/folders", { name: "B" });
    await me.send("PATCH", `/api/v1/folders/${created.folder.id}`, { name: "A2" });
    const renamed = await seqOf("SELECT seq FROM folders WHERE id = ?", created.folder.id);

    expect(first).toBeGreaterThan(0);
    expect(renamed).toBeGreaterThan((first ?? 0) + 1);
  });

  it("消したフォルダは印を付けて残り、同じ名前でもう一度作れる。中の購読は新しい番号でフォルダなしに戻る", async () => {
    const { me } = await setup();
    const { folder } = (await json(await me.send("POST", "/api/v1/folders", { name: "Tech" }))) as {
      folder: { id: string };
    };
    const { feed } = (await json(
      await me.send("POST", "/api/v1/feeds", {
        url: "https://shared.example/feed",
        folderId: folder.id,
      }),
    )) as { feed: { id: string } };
    const before = await seqOf("SELECT seq FROM subscriptions WHERE feed_id = ?", feed.id);

    await me.send("DELETE", `/api/v1/folders/${folder.id}`);

    const tombstone = await env.DB.prepare("SELECT deleted_at FROM folders WHERE id = ?")
      .bind(folder.id)
      .first<{ deleted_at: number | null }>();
    expect(tombstone?.deleted_at).not.toBeNull();
    expect(await seqOf("SELECT seq FROM subscriptions WHERE feed_id = ?", feed.id)).toBeGreaterThan(
      before ?? 0,
    );
    expect((await me.send("POST", "/api/v1/folders", { name: "Tech" })).status).toBe(201);
  });

  it("いちばん大きい番号の行を物理的に消しても、その番号は二度と使わない", async () => {
    const { platform, me } = await setup();
    const { feed } = (await json(
      await me.send("POST", "/api/v1/feeds", { url: "https://shared.example/feed" }),
    )) as { feed: { id: string } };
    await runFetchFeed(platform, feed.id);
    const max = await seqOf("SELECT max(seq) AS seq FROM user_articles");

    // 購読をやめると、受信箱の行（いちばん大きい番号の行を含む）が物理的に消える
    await me.send("DELETE", `/api/v1/feeds/${feed.id}`);
    expect(await seqOf("SELECT max(seq) AS seq FROM user_articles")).toBeNull();

    // もう一度購読して、記事が受信箱に入る
    await me.send("POST", "/api/v1/feeds", { url: "https://shared.example/feed" });
    const reused = await seqOf("SELECT min(seq) AS seq FROM user_articles");

    expect(reused).toBeGreaterThan(max ?? 0);
  });

  it("既読にして番号がいちばん大きくなった行を消しても、その番号は二度と使わない（#21 のレビュー）", async () => {
    const { platform, me } = await setup();
    const { feed } = (await json(
      await me.send("POST", "/api/v1/feeds", { url: "https://shared.example/feed" }),
    )) as { feed: { id: string } };
    await runFetchFeed(platform, feed.id);
    const [first] = ((await json(await me.get("/api/v1/articles"))) as { items: { id: string }[] })
      .items;
    // 既読にすると、その行がいちばん大きい番号になる
    await me.send("PATCH", `/api/v1/articles/${first?.id}`, { read: true });
    const max = await seqOf("SELECT max(seq) AS seq FROM user_articles");

    await me.send("DELETE", `/api/v1/feeds/${feed.id}`);
    await me.send("POST", "/api/v1/feeds", { url: "https://shared.example/feed" });

    expect(await seqOf("SELECT min(seq) AS seq FROM user_articles")).toBeGreaterThan(max ?? 0);
  });
});

describe("最近の記事の補充（#21 のレビュー）", () => {
  it("購読したあと補充の前に落ちても、もう一度補充すれば入り、補充済みならもう入れない", async () => {
    const { platform, me, otherId } = await setup();
    // ほかの人が先に購読して、記事が取り込まれている
    const { feed } = (await json(
      await me.send("POST", "/api/v1/feeds", { url: "https://shared.example/feed" }),
    )) as { feed: { id: string } };
    await runFetchFeed(platform, feed.id);
    // 購読だけ作られて、補充の前に落ちた
    await subscribeMany(platform.db, {
      userId: otherId,
      rows: [{ feedId: feed.id, folderId: null }],
      now: new Date(),
    });
    const before = await env.DB.prepare("SELECT count(*) AS n FROM user_articles WHERE user_id = ?")
      .bind(otherId)
      .first<{ n: number }>();
    expect(before?.n).toBe(0);

    // やり直し：補充の済んでいない購読に、もう一度補充する
    await backfillInbox(platform.db, { userId: otherId, feedIds: [feed.id], now: new Date() });

    const after = await env.DB.prepare("SELECT count(*) AS n FROM user_articles WHERE user_id = ?")
      .bind(otherId)
      .first<{ n: number }>();
    expect(after?.n).toBe(2);

    // 補充済みの印が付いたら、もう一度呼んでも何もしない
    await backfillInbox(platform.db, { userId: otherId, feedIds: [feed.id], now: new Date() });
    const again = await env.DB.prepare("SELECT count(*) AS n FROM user_articles WHERE user_id = ?")
      .bind(otherId)
      .first<{ n: number }>();
    expect(again?.n).toBe(2);
  });

  it("API で同じフィードをもう一度購読すると、補充の済んでいない購読は補充される", async () => {
    const { platform, me, other, otherId } = await setup();
    const { feed } = (await json(
      await me.send("POST", "/api/v1/feeds", { url: "https://shared.example/feed" }),
    )) as { feed: { id: string } };
    await runFetchFeed(platform, feed.id);
    await subscribeMany(platform.db, {
      userId: otherId,
      rows: [{ feedId: feed.id, folderId: null }],
      now: new Date(),
    });

    const res = await other.send("POST", "/api/v1/feeds", { url: "https://shared.example/feed" });

    expect(res.status).toBe(200);
    const list = (await json(await other.get("/api/v1/articles"))) as { items: unknown[] };
    expect(list.items).toHaveLength(2);
  });

  it("購読をやめたあとに補充の INSERT が走っても、やめた購読の記事は入らない（#21 のレビュー）", async () => {
    const { platform, me, otherId } = await setup();
    const { feed } = (await json(
      await me.send("POST", "/api/v1/feeds", { url: "https://shared.example/feed" }),
    )) as { feed: { id: string } };
    await runFetchFeed(platform, feed.id);
    await subscribeMany(platform.db, {
      userId: otherId,
      rows: [{ feedId: feed.id, folderId: null }],
      now: new Date(),
    });
    // 補充すべき購読を読んだあと、INSERT の前に購読をやめた
    await unsubscribe(platform.db, { userId: otherId, feedId: feed.id, now: new Date() });

    await insertRecentArticles(platform.db, { userId: otherId, feedIds: [feed.id], since: 0 });

    const inbox = await env.DB.prepare("SELECT count(*) AS n FROM user_articles WHERE user_id = ?")
      .bind(otherId)
      .first<{ n: number }>();
    expect(inbox?.n).toBe(0);
  });
});

describe("次の変更番号を振る速さ（#21 のレビュー）", () => {
  it.each(["folders", "subscriptions", "user_articles"])(
    "%s の最大の番号は、インデックスで 1 行だけ読んで取る",
    async (table) => {
      const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN SELECT max(seq) FROM ${table}`).all<{
        detail: string;
      }>();

      expect(plan.results.map((row) => row.detail).join("\n")).toMatch(
        new RegExp(`SEARCH ${table} USING COVERING INDEX ${table}_seq_idx`),
      );
    },
  );
});
