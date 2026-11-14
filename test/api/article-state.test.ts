import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { insertArticles, MAX_MARK_READ_IDS } from "../../src/db/articles";
import { insertFeed } from "../../src/db/feeds";
import { createFolder } from "../../src/db/folders";
import { createTestPlatform, requestApp } from "../helpers";

type ArticleJson = { id: string; readAt: string | null; starredAt: string | null };

const T0 = new Date("2026-11-14T00:00:00Z");
const T1 = new Date("2026-11-14T01:00:00Z");
const T2 = new Date("2026-11-14T02:00:00Z");
const NOW = new Date("2026-11-14T03:00:00Z");

/**
 * フォルダ「Tech」に入ったフィード a と、フォルダなしのフィード b。
 * a3 だけ、あとから（T2 に）取り込んだ記事。
 */
async function seed() {
  await env.DB.exec("DELETE FROM feeds");
  await env.DB.exec("DELETE FROM folders");
  const { platform } = createTestPlatform({ now: () => NOW });
  const folder = await createFolder(platform.db, { id: "tech", name: "Tech", now: T0 });
  await insertFeed(platform.db, {
    id: "a",
    url: "https://a.example/feed",
    now: T0,
    folderId: folder.id,
  });
  await insertFeed(platform.db, { id: "b", url: "https://b.example/feed", now: T0 });
  await insertArticles(
    platform.db,
    [
      { id: "a1", feedId: "a", createdAt: T0 },
      { id: "a2", feedId: "a", createdAt: T0 },
      { id: "a3", feedId: "a", createdAt: T2 },
      { id: "b1", feedId: "b", createdAt: T0 },
    ].map((row, i) => ({
      ...row,
      guid: row.id,
      url: null,
      title: row.id,
      summary: null,
      author: null,
      publishedAt: new Date(T0.getTime() + i * 60_000),
    })),
  );
  return platform;
}

const patch = (platform: Parameters<typeof requestApp>[0], id: string, json: unknown) =>
  requestApp(platform, `/api/v1/articles/${id}`, { method: "PATCH", json });

const markRead = (platform: Parameters<typeof requestApp>[0], json: unknown) =>
  requestApp(platform, "/api/v1/articles/mark-read", { method: "POST", json });

async function ids(platform: Parameters<typeof requestApp>[0], query: string) {
  const body = (await (await requestApp(platform, `/api/v1/articles?${query}`)).json()) as {
    items: ArticleJson[];
  };
  return body.items.map((item) => item.id).sort();
}

describe("PATCH /api/v1/articles/{id}", () => {
  let platform: Awaited<ReturnType<typeof seed>>;
  beforeEach(async () => {
    platform = await seed();
  });

  it("既読とスターを付けて外せる。すでにその状態なら時刻は変えない", async () => {
    const first = (await (await patch(platform, "a1", { read: true, starred: true })).json()) as {
      article: ArticleJson;
    };
    expect(first.article).toMatchObject({
      readAt: NOW.toISOString(),
      starredAt: NOW.toISOString(),
    });

    const later = createTestPlatform({ now: () => new Date("2026-11-15T00:00:00Z") }).platform;
    const again = (await (await patch(later, "a1", { read: true })).json()) as {
      article: ArticleJson;
    };
    expect(again.article.readAt).toBe(NOW.toISOString());

    const cleared = (await (
      await patch(platform, "a1", { read: false, starred: false })
    ).json()) as {
      article: ArticleJson;
    };
    expect(cleared.article).toMatchObject({ readAt: null, starredAt: null });
  });

  it("指定しなかったほうは変えない", async () => {
    await patch(platform, "a1", { starred: true });
    const res = (await (await patch(platform, "a1", { read: true })).json()) as {
      article: ArticleJson;
    };

    expect(res.article.starredAt).toBe(NOW.toISOString());
  });

  it("どちらも指定しなければ 400、記事がなければ 404", async () => {
    expect((await patch(platform, "a1", {})).status).toBe(400);
    expect((await patch(platform, "nope", { read: true })).status).toBe(404);
  });
});

describe("記事の一覧の絞り込み", () => {
  it("未読だけ、スター付きだけ、フォルダだけに絞り込める", async () => {
    const platform = await seed();
    await patch(platform, "a1", { read: true });
    await patch(platform, "b1", { starred: true });

    expect(await ids(platform, "state=unread")).toEqual(["a2", "a3", "b1"]);
    expect(await ids(platform, "state=starred")).toEqual(["b1"]);
    expect(await ids(platform, "folderId=tech")).toEqual(["a1", "a2", "a3"]);
    expect(await ids(platform, "folderId=tech&state=unread")).toEqual(["a2", "a3"]);
  });
});

describe("POST /api/v1/articles/mark-read", () => {
  let platform: Awaited<ReturnType<typeof seed>>;
  beforeEach(async () => {
    platform = await seed();
  });

  it("ID を並べて既読にする。もう一度送っても数えない", async () => {
    expect(await (await markRead(platform, { ids: ["a1", "b1", "nope"] })).json()).toEqual({
      updated: 2,
    });
    expect(await (await markRead(platform, { ids: ["a1"] })).json()).toEqual({ updated: 0 });
    expect(await ids(platform, "state=unread")).toEqual(["a2", "a3"]);
  });

  it("フィードを指定すると、until までに取り込んだ記事だけを既読にする", async () => {
    const res = await markRead(platform, { feedId: "a", until: T1.toISOString() });

    expect(await res.json()).toEqual({ updated: 2 });
    expect(await ids(platform, "state=unread")).toEqual(["a3", "b1"]);
  });

  it("フォルダを指定すると、そのフォルダのフィードだけを既読にする", async () => {
    await markRead(platform, { folderId: "tech", until: NOW.toISOString() });

    expect(await ids(platform, "state=unread")).toEqual(["b1"]);
  });

  it("すべてを既読にする", async () => {
    const res = await markRead(platform, { all: true, until: NOW.toISOString() });

    expect(await res.json()).toEqual({ updated: 4 });
    expect(await ids(platform, "state=unread")).toEqual([]);
  });

  it.each([
    ["範囲を指定しない", { until: NOW.toISOString() }],
    ["範囲を 2 つ指定する", { feedId: "a", all: true, until: NOW.toISOString() }],
    ["フィードに until がない", { feedId: "a" }],
    ["ID が多すぎる", { ids: Array.from({ length: MAX_MARK_READ_IDS + 1 }, (_, i) => `x${i}`) }],
    ["until が日時でない", { all: true, until: "yesterday" }],
  ])("%s なら 400", async (_label, body) => {
    const res = await markRead(platform, body);

    expect(res.status).toBe(400);
    expect(await ids(platform, "state=unread")).toEqual(["a1", "a2", "a3", "b1"]);
  });
});

describe("一覧を読んだあとに届いた記事", () => {
  it("一覧の asOf でまとめて既読にしても、一覧に出ていなかった記事は未読のまま残る", async () => {
    const platform = await seed();
    const list = (await (await requestApp(platform, "/api/v1/articles")).json()) as {
      items: ArticleJson[];
      asOf: string;
    };
    expect(list.items).toHaveLength(4);

    // 一覧を読んだあとに、取得のジョブが記事を入れる（createdAt は DB の時計で決まる）
    await insertArticles(platform.db, [
      {
        id: "late",
        feedId: "a",
        guid: "late",
        url: null,
        title: "late",
        summary: null,
        author: null,
        publishedAt: T0,
      },
    ]);

    await markRead(platform, { all: true, until: list.asOf });

    expect(await ids(platform, "state=unread")).toEqual(["late"]);
  });

  it("until と同じミリ秒に取り込んだ記事は、未読のまま残す", async () => {
    const platform = await seed();

    await markRead(platform, { all: true, until: T0.toISOString() });

    expect(await ids(platform, "state=unread")).toEqual(["a1", "a2", "a3", "b1"]);
  });
});

describe("同時に届いた変更", () => {
  it("同じ記事への既読が同時に 2 つ届いても、最初に付いた時刻を上書きしない", async () => {
    await seed();
    const first = createTestPlatform({ now: () => new Date("2026-11-14T10:00:00Z") }).platform;
    const second = createTestPlatform({ now: () => new Date("2026-11-14T11:00:00Z") }).platform;

    const responses = await Promise.all([
      patch(first, "a1", { read: true, starred: true }),
      patch(second, "a1", { read: true, starred: true }),
    ]);
    const articles = await Promise.all(
      responses.map(async (res) => ((await res.json()) as { article: ArticleJson }).article),
    );

    expect(articles[0]?.readAt).toBe(articles[1]?.readAt);
    expect(articles[0]?.starredAt).toBe(articles[1]?.starredAt);
  });
});

describe("GET /api/v1/unread-counts", () => {
  it("全体、フィードごと、フォルダごとの未読の数を返す", async () => {
    const platform = await seed();
    await patch(platform, "a1", { read: true });

    const res = await requestApp(platform, "/api/v1/unread-counts");

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      total: number;
      feeds: { feedId: string; unread: number }[];
      folders: { folderId: string; unread: number }[];
    };
    expect(body.total).toBe(3);
    expect(body.feeds.sort((x, y) => x.feedId.localeCompare(y.feedId))).toEqual([
      { feedId: "a", unread: 2 },
      { feedId: "b", unread: 1 },
    ]);
    expect(body.folders).toEqual([{ folderId: "tech", unread: 2 }]);
  });
});
