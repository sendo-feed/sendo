import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { insertArticles } from "../../src/db/articles";
import { listFolders } from "../../src/db/folders";
import { listSubscriptions } from "../../src/db/subscriptions";
import { runImportFeeds } from "../../src/jobs/import-feeds";
import { createTestPlatform, createUser, subscribeFeed, TEST_USER } from "../helpers";

const NOW = new Date("2026-11-14T00:00:00Z");
const userId = TEST_USER.id;

/** ユーザーの購読を、URL とフォルダ名の組で返す（URL の順） */
async function subscriptionsOf(id: string) {
  const { platform } = createTestPlatform();
  return (await listSubscriptions(platform.db, id))
    .map((s) => [s.feed.url, s.folderName] as const)
    .sort(([a], [b]) => a.localeCompare(b));
}

describe("runImportFeeds", () => {
  beforeEach(async () => {
    await env.DB.exec("DELETE FROM feeds");
    await env.DB.exec("DELETE FROM folders");
  });

  it("フォルダとフィードと購読を作り、新しいフィードの取得を積む", async () => {
    const { platform, enqueued } = createTestPlatform({ now: () => NOW });

    const result = await runImportFeeds(platform, {
      userId,
      entries: [
        { url: "https://a.example/feed", folder: "Tech" },
        { url: "https://b.example/feed", folder: "Tech" },
        { url: "https://c.example/feed", folder: null },
      ],
    });

    expect(result).toEqual({ subscribed: 3 });
    expect((await listFolders(platform.db, userId)).map((f) => f.name)).toEqual(["Tech"]);
    expect(await subscriptionsOf(userId)).toEqual([
      ["https://a.example/feed", "Tech"],
      ["https://b.example/feed", "Tech"],
      ["https://c.example/feed", null],
    ]);
    expect(enqueued.map((job) => job.type)).toEqual(["fetch-feed", "fetch-feed", "fetch-feed"]);
  });

  it("もう一度実行しても増えず、取得も積まない", async () => {
    const { platform, enqueued } = createTestPlatform({ now: () => NOW });
    const entries = [{ url: "https://a.example/feed", folder: "Tech" }];
    await runImportFeeds(platform, { userId, entries });
    enqueued.length = 0;

    expect(await runImportFeeds(platform, { userId, entries })).toEqual({ subscribed: 0 });
    expect(enqueued).toEqual([]);
    expect(await subscriptionsOf(userId)).toHaveLength(1);
  });

  it("既存の購読は、フォルダに入っていなければ入れ、入っていれば変えない", async () => {
    const { platform } = createTestPlatform({ now: () => NOW });
    await runImportFeeds(platform, {
      userId,
      entries: [
        { url: "https://loose.example/feed", folder: null },
        { url: "https://sorted.example/feed", folder: "Mine" },
      ],
    });

    await runImportFeeds(platform, {
      userId,
      entries: [
        { url: "https://loose.example/feed", folder: "Tech" },
        { url: "https://sorted.example/feed", folder: "Tech" },
      ],
    });

    expect(await subscriptionsOf(userId)).toEqual([
      ["https://loose.example/feed", "Tech"],
      ["https://sorted.example/feed", "Mine"],
    ]);
  });

  it("ほかの人が購読しているフィードは作らずに共有し、最近の記事を受信箱に入れる", async () => {
    const { platform, enqueued } = createTestPlatform({ now: () => new Date() });
    const feed = await subscribeFeed(platform, { url: "https://shared.example/feed" });
    const past = new Date(Date.now() - 60_000);
    await insertArticles(platform.db, [
      {
        id: "shared-1",
        feedId: feed.id,
        guid: "1",
        url: null,
        title: "1",
        summary: null,
        author: null,
        publishedAt: past,
        createdAt: past,
      },
    ]);
    const other = await createUser();

    await runImportFeeds(platform, {
      userId: other.id,
      entries: [{ url: "https://shared.example/feed", folder: "Shared" }],
    });

    expect(await subscriptionsOf(other.id)).toEqual([["https://shared.example/feed", "Shared"]]);
    expect(enqueued).toEqual([]);
    const inbox = await env.DB.prepare("SELECT article_id FROM user_articles WHERE user_id = ?")
      .bind(other.id)
      .all<{ article_id: string }>();
    expect(inbox.results.map((row) => row.article_id)).toEqual(["shared-1"]);
    // もとの購読者のフォルダには影響しない
    expect(await subscriptionsOf(userId)).toEqual([["https://shared.example/feed", null]]);
  });

  it("D1 の変数の上限を超える件数でも、分けて書き込む", async () => {
    const { platform } = createTestPlatform({ now: () => NOW });
    const entries = Array.from({ length: 120 }, (_, i) => ({
      url: `https://f${i}.example/feed`,
      folder: `Folder ${i % 60}`,
    }));

    expect(await runImportFeeds(platform, { userId, entries })).toEqual({ subscribed: 120 });
    expect(await listFolders(platform.db, userId)).toHaveLength(60);
  });

  // 本番のジョブは IMPORT_CHUNK_SIZE 件ずつだが、ここで使う関数は件数を問わず分けて書き込む約束なので、
  // 条件の変数を足しても D1 の上限（1 文あたり 100 個）に収まることを確かめる
  it("D1 の変数の上限を超える件数の既存の購読も、分けてフォルダに入れる", async () => {
    const { platform } = createTestPlatform({ now: () => NOW });
    const urls = Array.from({ length: 120 }, (_, i) => `https://f${i}.example/feed`);
    await runImportFeeds(platform, { userId, entries: urls.map((url) => ({ url, folder: null })) });

    await runImportFeeds(platform, {
      userId,
      entries: urls.map((url) => ({ url, folder: "Big" })),
    });

    const folders = (await subscriptionsOf(userId)).map(([, folder]) => folder);
    expect(folders).toEqual(urls.map(() => "Big"));
  });

  it("ほかの人が購読しているフィードを D1 の変数の上限を超える件数取り込んでも、最近の記事を受信箱に入れる", async () => {
    const { platform } = createTestPlatform({ now: () => new Date() });
    const entries = Array.from({ length: 120 }, (_, i) => ({
      url: `https://f${i}.example/feed`,
      folder: null,
    }));
    const other = await createUser();
    await runImportFeeds(platform, { userId: other.id, entries });
    const last = await env.DB.prepare("SELECT id FROM feeds WHERE url = ?")
      .bind(entries[119]?.url)
      .first<{ id: string }>();
    const past = new Date(Date.now() - 60_000);
    await insertArticles(platform.db, [
      {
        id: "last-1",
        feedId: last?.id ?? "",
        guid: "1",
        url: null,
        title: "1",
        summary: null,
        author: null,
        publishedAt: past,
        createdAt: past,
      },
    ]);

    expect(await runImportFeeds(platform, { userId, entries })).toEqual({ subscribed: 120 });
    const inbox = await env.DB.prepare("SELECT article_id FROM user_articles WHERE user_id = ?")
      .bind(userId)
      .all<{ article_id: string }>();
    expect(inbox.results.map((row) => row.article_id)).toEqual(["last-1"]);
  });

  it("キューの中身が書き換えられていても、内部の URL は登録しない", async () => {
    const { platform } = createTestPlatform({ now: () => NOW });

    const result = await runImportFeeds(platform, {
      userId,
      entries: [
        { url: "http://localhost/feed", folder: null },
        { url: "https://ok.example/feed", folder: null },
      ],
    });

    expect(result).toEqual({ subscribed: 1 });
    expect(await subscriptionsOf(userId)).toEqual([["https://ok.example/feed", null]]);
  });
});
