import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import { ITEM_ID_LIMIT, insertArticles } from "../../src/db/articles";
import { QUERY_BUDGET } from "../../src/db/chunk";
import { createFolder } from "../../src/db/folders";
import * as schema from "../../src/db/schema";
import { parseItemId, parseStreamId, toLongItemId } from "../../src/greader/ids";
import type { Platform } from "../../src/platform";
import {
  addToInbox,
  createTestPlatform,
  createUser,
  fakeFetch,
  requestApp,
  subscribeFeed,
} from "../helpers";

const DAY = 24 * 60 * 60 * 1000;
const READ = "user/-/state/com.google/read";
const STARRED = "user/-/state/com.google/starred";
const READING_LIST = "user/-/state/com.google/reading-list";

type ItemJson = {
  id: string;
  title: string;
  summary: { content: string };
  categories: string[];
  origin: { streamId: string };
  canonical: { href: string }[];
};

/** リーダーアプリのように、GoogleLogin のヘッダーとフォームで送る */
function reader(platform: Platform, token: string) {
  return async (
    path: string,
    options: { method?: string; form?: [string, string][]; auth?: string | null } = {},
  ) => {
    const headers = new Headers();
    if (options.auth !== null)
      headers.set("authorization", options.auth ?? `GoogleLogin auth=${token}`);
    if (options.form) headers.set("content-type", "application/x-www-form-urlencoded");
    return createApp(platform).request(`https://sendo.example.com${path}`, {
      method: options.method ?? (options.form ? "POST" : "GET"),
      headers,
      ...(options.form && { body: new URLSearchParams(options.form).toString() }),
    });
  };
}

/** 記事を入れて、ユーザーの受信箱に入れる。アイテムの ID を返す */
async function seed(
  platform: Platform,
  input: {
    userId: string;
    feedId: string;
    rows: {
      id: string;
      title?: string;
      summary?: string;
      publishedAt: Date;
      receivedAt?: Date;
      read?: boolean;
      starred?: boolean;
    }[];
  },
) {
  await insertArticles(
    platform.db,
    input.rows.map((row) => ({
      id: row.id,
      feedId: input.feedId,
      guid: row.id,
      url: `https://blog.example.com/${row.id}`,
      title: row.title ?? row.id,
      summary: row.summary ?? null,
      author: null,
      publishedAt: row.publishedAt,
      createdAt: row.publishedAt,
    })),
  );
  await addToInbox(
    platform,
    input.rows.map((row) => ({
      articleId: row.id,
      feedId: input.feedId,
      publishedAt: row.publishedAt,
      receivedAt: row.receivedAt ?? row.publishedAt,
      userId: input.userId,
    })),
  );
  const ids = new Map<string, number>();
  for (const row of input.rows) {
    if (row.read || row.starred) {
      await env.DB.prepare(
        "UPDATE user_articles SET read_at = ?, starred_at = ? WHERE user_id = ? AND article_id = ?",
      )
        .bind(row.read ? 1 : null, row.starred ? 1 : null, input.userId, row.id)
        .run();
    }
    const found = await env.DB.prepare("SELECT item_id FROM articles WHERE id = ?")
      .bind(row.id)
      .first<{ item_id: number }>();
    ids.set(row.id, found?.item_id ?? 0);
  }
  return ids;
}

async function state(userId: string, articleId: string) {
  return env.DB.prepare(
    "SELECT read_at IS NOT NULL AS read, starred_at IS NOT NULL AS starred FROM user_articles WHERE user_id = ? AND article_id = ?",
  )
    .bind(userId, articleId)
    .first<{ read: number; starred: number }>();
}

/** ログインしたユーザーと、購読しているフィード（フォルダ Tech の中） */
async function setup() {
  const user = await createUser();
  const { platform } = createTestPlatform();
  const folder = await createFolder(platform.db, {
    userId: user.id,
    id: crypto.randomUUID(),
    name: "Tech",
    now: new Date(),
  });
  const feed = await subscribeFeed(platform, { userId: user.id, folderId: folder.id });
  return { user, platform, feed, folder, send: reader(platform, user.token) };
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM feeds");
});

describe("ログイン（ClientLogin）", () => {
  it("メールとアクセストークンが合えば、Auth にトークンを入れて返す。そのあとは GoogleLogin で使える", async () => {
    const { platform, user } = await setup();
    const send = reader(platform, user.token);

    const res = await send("/accounts/ClientLogin", {
      auth: null,
      form: [
        ["Email", user.email.toUpperCase()],
        ["Passwd", user.token],
      ],
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toBe(`SID=${user.token}\nLSID=${user.token}\nAuth=${user.token}\n`);

    // クエリで送ってくるアプリもある。output=json なら JSON で返す
    const json = await send(
      `/accounts/ClientLogin?Email=${encodeURIComponent(user.email)}&Passwd=${user.token}&output=json`,
      { auth: null },
    );
    expect(await json.json()).toEqual({ SID: user.token, LSID: user.token, Auth: user.token });

    expect((await send("/reader/api/0/user-info")).status).toBe(200);
    expect((await send("/reader/api/0/user-info", { auth: `Bearer ${user.token}` })).status).toBe(
      200,
    );
  });

  it("メールが違う、トークンが違う、どちらかがないときは受けない", async () => {
    const { platform, user } = await setup();
    const other = await createUser();
    const send = reader(platform, user.token);

    for (const form of [
      [
        ["Email", other.email],
        ["Passwd", user.token],
      ],
      [
        ["Email", user.email],
        ["Passwd", "sendo_wrong"],
      ],
      [["Email", user.email]],
      [],
    ] as [string, string][][]) {
      const res = await send("/accounts/ClientLogin", { auth: null, form });
      expect(res.status, JSON.stringify(form)).toBe(401);
      expect(await res.text()).toBe("Error=BadAuthentication\n");
    }
  });

  it("認証のないリクエストや、正しくないトークンは 401", async () => {
    const { send } = await setup();

    expect((await send("/reader/api/0/subscription/list", { auth: null })).status).toBe(401);
    expect(
      (await send("/reader/api/0/subscription/list", { auth: "GoogleLogin auth=sendo_wrong" }))
        .status,
    ).toBe(401);
  });

  it("T を配る。書き込みで T を確かめない（ヘッダーで認証しているので）", async () => {
    const { send } = await setup();

    const token = await (await send("/reader/api/0/token")).text();
    expect(token).toMatch(/^[A-Za-z0-9_-]{40}$/);
    expect(await (await send("/reader/api/0/token")).text()).toBe(token);
    const res = await send("/reader/api/0/edit-tag", {
      form: [
        ["T", "anything"],
        ["a", READ],
      ],
    });
    expect(res.status).toBe(200);
  });
});

describe("購読とフォルダの一覧", () => {
  it("購読をフィードの ID で、フォルダをラベルで返す", async () => {
    const { send, feed } = await setup();

    const subscriptions = (await (
      await send("/reader/api/0/subscription/list?output=json")
    ).json()) as {
      subscriptions: { id: string; categories: { id: string; label: string }[]; url: string }[];
    };
    expect(subscriptions.subscriptions).toEqual([
      expect.objectContaining({
        id: `feed/${feed.id}`,
        url: feed.url,
        categories: [{ id: "user/-/label/Tech", label: "Tech" }],
      }),
    ]);

    const tags = (await (await send("/reader/api/0/tag/list?output=json")).json()) as {
      tags: { id: string; type?: string }[];
    };
    expect(tags.tags).toEqual([{ id: STARRED }, { id: "user/-/label/Tech", type: "folder" }]);
  });
});

describe("ストリーム", () => {
  it("記事の ID を 10 進で返し、続き（c）で全部たどれる。xt=read で未読だけ、r=o で古い順", async () => {
    const { platform, user, feed, send } = await setup();
    const base = Date.now() - 10 * DAY;
    const ids = await seed(platform, {
      userId: user.id,
      feedId: feed.id,
      rows: Array.from({ length: 5 }, (_, i) => ({
        id: `s${i}`,
        publishedAt: new Date(base + i * DAY),
        read: i === 2,
      })),
    });

    const pages: string[][] = [];
    let c: string | undefined;
    do {
      const query = `s=${READING_LIST}&xt=${READ}&n=2${c ? `&c=${encodeURIComponent(c)}` : ""}`;
      const body = (await (await send(`/reader/api/0/stream/items/ids?${query}`)).json()) as {
        itemRefs: { id: string; timestampUsec: string }[];
        continuation?: string;
      };
      pages.push(body.itemRefs.map((ref) => ref.id));
      c = body.continuation;
    } while (c !== undefined);

    // 新しい順。既読の s2 は除く
    expect(pages).toEqual([
      [String(ids.get("s4")), String(ids.get("s3"))],
      [String(ids.get("s1")), String(ids.get("s0"))],
    ]);

    const oldest = (await (
      await send(`/reader/api/0/stream/items/ids?s=${READING_LIST}&r=o&n=10`)
    ).json()) as { itemRefs: { id: string }[] };
    expect(oldest.itemRefs.map((ref) => ref.id)).toEqual(
      ["s0", "s1", "s2", "s3", "s4"].map((id) => String(ids.get(id))),
    );
  });

  it("ot は受信箱に入った時刻（秒）で絞る（公開日時の古い記事があとから入っても取りこぼさない）", async () => {
    const { platform, user, feed, send } = await setup();
    const since = Math.floor(Date.now() / 1000) - 60;
    const ids = await seed(platform, {
      userId: user.id,
      feedId: feed.id,
      rows: [
        {
          id: "before",
          publishedAt: new Date(Date.now() - DAY),
          receivedAt: new Date((since - 1) * 1000),
        },
        // 公開日時は古いが、ot のあとに受信箱に入った
        {
          id: "late",
          publishedAt: new Date(Date.now() - 30 * DAY),
          receivedAt: new Date(since * 1000),
        },
      ],
    });

    const body = (await (
      await send(`/reader/api/0/stream/items/ids?s=${READING_LIST}&ot=${since}`)
    ).json()) as { itemRefs: { id: string }[] };

    expect(body.itemRefs.map((ref) => ref.id)).toEqual([String(ids.get("late"))]);
  });

  it("スター、フォルダ（ラベル）、フィードのストリームで絞る", async () => {
    const { platform, user, feed, send } = await setup();
    const other = await subscribeFeed(platform, { userId: user.id });
    const now = Date.now();
    const ids = await seed(platform, {
      userId: user.id,
      feedId: feed.id,
      rows: [
        { id: "tech-starred", publishedAt: new Date(now - 1000), starred: true },
        { id: "tech-plain", publishedAt: new Date(now - 2000) },
      ],
    });
    const otherIds = await seed(platform, {
      userId: user.id,
      feedId: other.id,
      rows: [{ id: "other", publishedAt: new Date(now - 3000) }],
    });
    const refs = async (stream: string) =>
      (
        (await (
          await send(`/reader/api/0/stream/items/ids?s=${encodeURIComponent(stream)}&n=10`)
        ).json()) as { itemRefs: { id: string }[] }
      ).itemRefs.map((ref) => ref.id);

    expect(await refs(STARRED)).toEqual([String(ids.get("tech-starred"))]);
    expect(await refs("user/-/label/Tech")).toEqual([
      String(ids.get("tech-starred")),
      String(ids.get("tech-plain")),
    ]);
    expect(await refs(`feed/${other.id}`)).toEqual([String(otherIds.get("other"))]);
    expect(await refs("user/-/label/Unknown")).toEqual([]);
    expect((await send("/reader/api/0/stream/items/ids?s=unknown/stream")).status).toBe(400);
  });

  it("中身を、長い形のアイテムの ID で返す。タイトルと要約は HTML にエスケープする", async () => {
    const { platform, user, feed, send } = await setup();
    const ids = await seed(platform, {
      userId: user.id,
      feedId: feed.id,
      rows: [
        {
          id: "html",
          title: "Tom & Jerry <script>",
          summary: '<img src=x onerror="alert(1)">',
          publishedAt: new Date(Date.now() - 1000),
          read: true,
          starred: true,
        },
      ],
    });
    const itemId = ids.get("html") ?? 0;

    // 長い形、16 桁の 16 進、10 進のどれでも引ける
    for (const i of [toLongItemId(itemId), itemId.toString(16).padStart(16, "0"), String(itemId)]) {
      const res = await send("/reader/api/0/stream/items/contents", {
        form: [
          ["i", i],
          ["output", "json"],
        ],
      });
      const body = (await res.json()) as { items: ItemJson[] };
      expect(body.items, i).toHaveLength(1);
      const [item] = body.items;
      expect(item?.id).toBe(toLongItemId(itemId));
      expect(item?.title).toBe("Tom &amp; Jerry &lt;script&gt;");
      expect(item?.summary.content).toBe("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
      expect(item?.categories).toEqual([READING_LIST, READ, STARRED, "user/-/label/Tech"]);
      expect(item?.origin.streamId).toBe(`feed/${feed.id}`);
      expect(item?.canonical).toEqual([{ href: "https://blog.example.com/html" }]);
    }
  });

  it("ほかの人の受信箱の記事は、ID を知っていても返さない", async () => {
    const { platform, user, feed } = await setup();
    const ids = await seed(platform, {
      userId: user.id,
      feedId: feed.id,
      rows: [{ id: "mine", publishedAt: new Date() }],
    });
    const stranger = await createUser();

    const res = await reader(platform, stranger.token)("/reader/api/0/stream/items/contents", {
      form: [["i", String(ids.get("mine"))]],
    });

    expect(((await res.json()) as { items: unknown[] }).items).toEqual([]);
  });

  it("stream/contents は、パスのストリームの記事を中身まで返す", async () => {
    const { platform, user, feed, send } = await setup();
    const ids = await seed(platform, {
      userId: user.id,
      feedId: feed.id,
      rows: [
        { id: "c1", publishedAt: new Date(Date.now() - 1000) },
        { id: "c2", publishedAt: new Date(Date.now() - 2000), read: true },
      ],
    });

    const res = await send(
      `/reader/api/0/stream/contents/${encodeURIComponent(`feed/${feed.id}`)}?xt=${READ}`,
    );
    const body = (await res.json()) as { id: string; items: ItemJson[] };

    expect(body.id).toBe(`feed/${feed.id}`);
    expect(body.items.map((item) => item.id)).toEqual([toLongItemId(ids.get("c1") ?? 0)]);
    const all = (await (await send(`/reader/api/0/stream/contents/${READING_LIST}`)).json()) as {
      items: ItemJson[];
    };
    expect(all.items).toHaveLength(2);
  });
});

describe("状態を変える", () => {
  it("edit-tag で既読・スターを付け外しし、REST API と同期にも届く", async () => {
    const { platform, user, feed, send } = await setup();
    const ids = await seed(platform, {
      userId: user.id,
      feedId: feed.id,
      rows: [
        { id: "e1", publishedAt: new Date(Date.now() - 1000) },
        { id: "e2", publishedAt: new Date(Date.now() - 2000) },
      ],
    });
    const items = ["e1", "e2"].map((id) => toLongItemId(ids.get(id) ?? 0));
    const before = await env.DB.prepare("SELECT max(seq) AS seq FROM user_articles").first<{
      seq: number;
    }>();

    await send("/reader/api/0/edit-tag", {
      form: [...items.map((i): [string, string] => ["i", i]), ["a", READ], ["a", STARRED]],
    });
    expect(await state(user.id, "e1")).toEqual({ read: 1, starred: 1 });
    expect(await state(user.id, "e2")).toEqual({ read: 1, starred: 1 });
    // 変更番号が進むので、同期（sendo-reader）にも届く
    const changed = await env.DB.prepare(
      "SELECT count(*) AS n FROM user_articles WHERE user_id = ? AND seq > ?",
    )
      .bind(user.id, before?.seq ?? 0)
      .first<{ n: number }>();
    expect(changed?.n).toBe(2);

    await send("/reader/api/0/edit-tag", {
      form: [
        ["i", items[0] ?? ""],
        ["r", READ],
        ["r", STARRED],
      ],
    });
    expect(await state(user.id, "e1")).toEqual({ read: 0, starred: 0 });

    // kept-unread を付けたら未読にする
    await send("/reader/api/0/edit-tag", {
      form: [
        ["i", items[1] ?? ""],
        ["a", "user/-/state/com.google/kept-unread"],
      ],
    });
    expect(await state(user.id, "e2")).toEqual({ read: 0, starred: 1 });

    const list = (await (
      await requestApp(platform, `/api/v1/articles?feedId=${feed.id}`, { token: user.token })
    ).json()) as { items: { id: string; readAt: string | null; starredAt: string | null }[] };
    const e2 = list.items.find((item) => item.id === "e2");
    expect(e2?.readAt).toBeNull();
    expect(e2?.starredAt).not.toBeNull();
  });

  it("リーダーアプリで未読に戻した記事は、sendo-reader の古いカーソルの「すべて既読」で既読にならない", async () => {
    const { platform, user, feed, send } = await setup();
    const ids = await seed(platform, {
      userId: user.id,
      feedId: feed.id,
      rows: [{ id: "back", publishedAt: new Date(Date.now() - 1000), read: true }],
    });
    // sendo-reader が同期を送り切った（既読として手元に届いた）
    let cursor: string | undefined;
    for (let i = 0; i < 10; i++) {
      const query = cursor === undefined ? "" : `?cursor=${cursor}`;
      const body = (await (
        await requestApp(platform, `/api/v1/sync${query}`, { token: user.token })
      ).json()) as { cursor: string; hasMore: boolean };
      cursor = body.cursor;
      if (!body.hasMore) break;
    }

    await send("/reader/api/0/edit-tag", {
      form: [
        ["i", String(ids.get("back"))],
        ["r", READ],
      ],
    });
    const res = await requestApp(platform, "/api/v1/articles/mark-read", {
      method: "POST",
      token: user.token,
      json: { all: true, cursor },
    });

    expect(await res.json()).toEqual({ updated: 0 });
    expect(await state(user.id, "back")).toEqual({ read: 0, starred: 0 });
  });

  it("ほかの人の記事は、アイテムの ID を送っても変えない", async () => {
    const { platform, user, feed } = await setup();
    const ids = await seed(platform, {
      userId: user.id,
      feedId: feed.id,
      rows: [{ id: "victim", publishedAt: new Date() }],
    });
    const stranger = await createUser();

    await reader(platform, stranger.token)("/reader/api/0/edit-tag", {
      form: [
        ["i", String(ids.get("victim"))],
        ["a", READ],
      ],
    });

    expect(await state(user.id, "victim")).toEqual({ read: 0, starred: 0 });
  });

  it("mark-all-as-read は、ts より前に受信箱に入った記事だけを既読にする", async () => {
    const { platform, user, feed, send } = await setup();
    const now = Date.now();
    await seed(platform, {
      userId: user.id,
      feedId: feed.id,
      rows: [
        { id: "old", publishedAt: new Date(now - 2000), receivedAt: new Date(now - 2000) },
        { id: "new", publishedAt: new Date(now - 1000), receivedAt: new Date(now - 1000) },
      ],
    });

    await send("/reader/api/0/mark-all-as-read", {
      form: [
        ["s", `feed/${feed.id}`],
        ["ts", String((now - 1500) * 1000)],
      ],
    });
    expect(await state(user.id, "old")).toEqual({ read: 1, starred: 0 });
    expect(await state(user.id, "new")).toEqual({ read: 0, starred: 0 });

    await send("/reader/api/0/mark-all-as-read", { form: [["s", "user/-/label/Tech"]] });
    expect(await state(user.id, "new")).toEqual({ read: 1, starred: 0 });
  });

  it("未読の数を、フィード、フォルダ、すべての記事ごとに返す", async () => {
    const { platform, user, feed, send } = await setup();
    const now = Date.now();
    await seed(platform, {
      userId: user.id,
      feedId: feed.id,
      rows: [
        { id: "u1", publishedAt: new Date(now - 2000), receivedAt: new Date(now - 2000) },
        { id: "u2", publishedAt: new Date(now - 1000), receivedAt: new Date(now - 1000) },
        { id: "r1", publishedAt: new Date(now - 500), read: true },
      ],
    });

    const body = (await (await send("/reader/api/0/unread-count?output=json")).json()) as {
      max: number;
      unreadcounts: { id: string; count: number; newestItemTimestampUsec: string }[];
    };

    expect(body.max).toBe(2);
    const newest = String((now - 1000) * 1000);
    expect(body.unreadcounts).toEqual([
      { id: `feed/${feed.id}`, count: 2, newestItemTimestampUsec: newest },
      { id: "user/-/label/Tech", count: 2, newestItemTimestampUsec: newest },
      { id: READING_LIST, count: 2, newestItemTimestampUsec: newest },
    ]);
  });
});

describe("購読を変える", () => {
  it("quickadd で URL から購読する。取得できない URL は numResults: 0", async () => {
    const user = await createUser();
    const rss = `<rss version="2.0"><channel><title>Quick</title><link>https://quick.example.com/</link></channel></rss>`;
    const { fetch } = fakeFetch(
      () => new Response(rss, { headers: { "content-type": "application/rss+xml" } }),
    );
    const { platform } = createTestPlatform({ fetch });
    const send = reader(platform, user.token);

    const res = await send("/reader/api/0/subscription/quickadd", {
      form: [["quickadd", "https://quick.example.com/feed.xml"]],
    });
    const body = (await res.json()) as { numResults: number; streamId: string; streamName: string };
    expect(body).toMatchObject({ numResults: 1, streamName: "Quick" });
    const list = (await (await send("/reader/api/0/subscription/list")).json()) as {
      subscriptions: { id: string }[];
    };
    expect(list.subscriptions.map((s) => s.id)).toEqual([body.streamId]);

    const rejected = await send("/reader/api/0/subscription/quickadd", {
      form: [["quickadd", "http://127.0.0.1/feed"]],
    });
    expect(await rejected.json()).toMatchObject({ numResults: 0 });
  });

  it("subscription/edit でフォルダに入れる（なければ作る）・外す・購読をやめる・購読し直す", async () => {
    const { send, feed } = await setup();
    const folderOf = async () =>
      (
        (await (await send("/reader/api/0/subscription/list")).json()) as {
          subscriptions: { id: string; categories: { label: string }[] }[];
        }
      ).subscriptions
        .find((s) => s.id === `feed/${feed.id}`)
        ?.categories.map((c) => c.label);

    await send("/reader/api/0/subscription/edit", {
      form: [
        ["ac", "edit"],
        ["s", `feed/${feed.id}`],
        ["a", "user/-/label/News"],
        ["r", "user/-/label/Tech"],
      ],
    });
    expect(await folderOf()).toEqual(["News"]);

    await send("/reader/api/0/subscription/edit", {
      form: [
        ["ac", "edit"],
        ["s", `feed/${feed.id}`],
        ["r", "user/-/label/News"],
      ],
    });
    expect(await folderOf()).toEqual([]);

    await send("/reader/api/0/subscription/edit", {
      form: [
        ["ac", "unsubscribe"],
        ["s", `feed/${feed.id}`],
      ],
    });
    expect(await folderOf()).toBeUndefined();

    await send("/reader/api/0/subscription/edit", {
      form: [
        ["ac", "subscribe"],
        ["s", `feed/${feed.id}`],
        ["a", "user/-/label/Tech"],
      ],
    });
    expect(await folderOf()).toEqual(["Tech"]);
  });

  it("フォルダから外す（r）間に、ほかのリクエストが別のフォルダへ移しても、移した先からは外さない（#38 のレビュー）", async () => {
    const { user, feed, folder } = await setup();
    const news = await createFolder(createTestPlatform().platform.db, {
      userId: user.id,
      id: crypto.randomUUID(),
      name: "News",
      now: new Date(),
    });
    // 購読のフォルダを書き換える文の直前に、ほかのリクエストが News へ移す
    let armed = true;
    const hooked = new Proxy(env.DB, {
      get(target, prop) {
        if (prop !== "prepare") {
          const value = Reflect.get(target, prop, target);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return (query: string) => {
          const statement = target.prepare(query);
          if (!armed || !/^\s*update\s+"subscriptions"/i.test(query)) return statement;
          armed = false;
          return new Proxy(statement, {
            get(stmt, key) {
              const value = Reflect.get(stmt, key, stmt);
              if (key === "bind") {
                return (...args: unknown[]) => {
                  const bound = value.apply(stmt, args) as D1PreparedStatement;
                  const run =
                    (method: "all" | "first" | "run" | "raw") =>
                    async (...rest: unknown[]) => {
                      await env.DB.prepare(
                        "UPDATE subscriptions SET folder_id = ? WHERE user_id = ? AND feed_id = ? AND deleted_at IS NULL",
                      )
                        .bind(news.id, user.id, feed.id)
                        .run();
                      return (bound[method] as (...a: unknown[]) => unknown).apply(bound, rest);
                    };
                  return new Proxy(bound, {
                    get(b, k) {
                      if (k === "all" || k === "first" || k === "run" || k === "raw") return run(k);
                      const v = Reflect.get(b, k, b);
                      return typeof v === "function" ? v.bind(b) : v;
                    },
                  });
                };
              }
              return typeof value === "function" ? value.bind(stmt) : value;
            },
          });
        };
      },
    });
    const { platform } = createTestPlatform({ db: drizzle(hooked, { schema }) });

    const res = await reader(platform, user.token)("/reader/api/0/subscription/edit", {
      form: [
        ["ac", "edit"],
        ["s", `feed/${feed.id}`],
        ["r", `user/-/label/${folder.name}`],
      ],
    });

    expect(res.status).toBe(200);
    expect(armed).toBe(false);
    const row = await env.DB.prepare(
      "SELECT folder_id FROM subscriptions WHERE user_id = ? AND feed_id = ? AND deleted_at IS NULL",
    )
      .bind(user.id, feed.id)
      .first<{ folder_id: string | null }>();
    expect(row?.folder_id).toBe(news.id);
  });

  it("rename-tag でフォルダの名前を変え、disable-tag で消す", async () => {
    const { send } = await setup();
    const labels = async () =>
      (
        (await (await send("/reader/api/0/tag/list")).json()) as { tags: { id: string }[] }
      ).tags.map((tag) => tag.id);

    await send("/reader/api/0/rename-tag", {
      form: [
        ["s", "user/-/label/Tech"],
        ["dest", "user/-/label/Engineering"],
      ],
    });
    expect(await labels()).toEqual([STARRED, "user/-/label/Engineering"]);

    await send("/reader/api/0/disable-tag", { form: [["s", "user/-/label/Engineering"]] });
    expect(await labels()).toEqual([STARRED]);
  });
});

describe("アイテムの ID", () => {
  it("取り込んだ記事に、1 以上 2^53 未満の重ならない整数を振る", async () => {
    const { platform, user, feed } = await setup();
    const ids = await seed(platform, {
      userId: user.id,
      feedId: feed.id,
      rows: Array.from({ length: 50 }, (_, i) => ({ id: `n${i}`, publishedAt: new Date() })),
    });

    const values = [...ids.values()];
    expect(new Set(values).size).toBe(50);
    for (const value of values) {
      expect(Number.isSafeInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(1);
      expect(value).toBeLessThan(ITEM_ID_LIMIT);
    }
  });

  it("長い形、16 桁の 16 進、10 進を読み、範囲の外や形の違うものは受けない", () => {
    expect(toLongItemId(0x148b9369)).toBe("tag:google.com,2005:reader/item/00000000148b9369");
    expect(parseItemId("tag:google.com,2005:reader/item/00000000148b9369")).toBe(0x148b9369);
    expect(parseItemId("tag:google.com,2005:reader/item/2f2")).toBe(0x2f2);
    expect(parseItemId("000000000000048c")).toBe(0x48c);
    expect(parseItemId("12345")).toBe(12345);
    // 16 桁の 10 進（10^15 以上の ID）は、16 進として読むと範囲の外なので 10 進として読む
    expect(parseItemId("8999999999999999")).toBe(8999999999999999);
    expect(parseItemId("001fffffffffffff")).toBe(2 ** 53 - 1);
    for (const value of [
      "0",
      "-1",
      "tag:google.com,2005:reader/item/",
      "tag:google.com,2005:reader/item/0020000000000000",
      "ffffffffffffffff",
      "9999999999999999",
      "0123",
      "12a",
      "",
    ]) {
      expect(parseItemId(value), value).toBeUndefined();
    }
  });

  it("ストリームの ID は、user/<ID>/ の形も user/-/ と同じに読む", () => {
    expect(parseStreamId("user/1234/state/com.google/read")).toEqual({ kind: "read" });
    expect(parseStreamId("user/-/label/Tech")).toEqual({ kind: "label", name: "Tech" });
    expect(parseStreamId("feed/abc")).toEqual({ kind: "feed", feedId: "abc" });
    expect(parseStreamId("user/-/state/com.google/broadcast")).toBeUndefined();
  });
});

describe("D1 のクエリの上限", () => {
  it("記事を上限（1000 件）まで一度に読む ／ 変えても、QUERY_BUDGET に収まる", async () => {
    const { platform, user, feed } = await setup();
    const now = Date.now();
    await insertArticles(
      platform.db,
      Array.from({ length: 1000 }, (_, i) => ({
        id: `q${i}`,
        feedId: feed.id,
        guid: `q${i}`,
        url: null,
        title: null,
        summary: null,
        author: null,
        publishedAt: new Date(now - i),
        createdAt: new Date(now - i),
      })),
    );
    await env.DB.prepare(
      `INSERT INTO user_articles (user_id, article_id, feed_id, published_at, created_at, seq, read_seq)
       SELECT ?, id, feed_id, published_at, created_at, 1, 1 FROM articles WHERE feed_id = ?`,
    )
      .bind(user.id, feed.id)
      .run();
    const itemIds = (
      await env.DB.prepare("SELECT item_id FROM articles WHERE feed_id = ?")
        .bind(feed.id)
        .all<{ item_id: number }>()
    ).results.map((row) => String(row.item_id));
    expect(itemIds).toHaveLength(1000);

    const counted = createTestPlatform();
    const send = reader(counted.platform, user.token);
    const form = itemIds.map((i): [string, string] => ["i", i]);

    counted.resetQueryCount();
    const ids = await send(`/reader/api/0/stream/items/ids?s=${READING_LIST}&n=1000`);
    expect(((await ids.json()) as { itemRefs: unknown[] }).itemRefs).toHaveLength(1000);
    expect(counted.queryCount()).toBeLessThanOrEqual(QUERY_BUDGET);

    counted.resetQueryCount();
    const contents = await send("/reader/api/0/stream/items/contents", { form });
    expect(((await contents.json()) as { items: unknown[] }).items).toHaveLength(1000);
    expect(counted.queryCount()).toBeLessThanOrEqual(QUERY_BUDGET);

    counted.resetQueryCount();
    await send("/reader/api/0/edit-tag", {
      form: [...form, ["a", READ], ["a", STARRED]],
    });
    expect(counted.queryCount()).toBeLessThanOrEqual(QUERY_BUDGET);
    const unread = await env.DB.prepare(
      "SELECT count(*) AS n FROM user_articles WHERE user_id = ? AND read_at IS NULL",
    )
      .bind(user.id)
      .first<{ n: number }>();
    expect(unread?.n).toBe(0);
  });
});
