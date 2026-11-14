import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { listFeeds } from "../../src/db/feeds";
import { listFolders } from "../../src/db/folders";
import { runImportFeeds } from "../../src/jobs/import-feeds";
import { createTestPlatform } from "../helpers";

const NOW = new Date("2026-11-14T00:00:00Z");

describe("runImportFeeds", () => {
  beforeEach(async () => {
    await env.DB.exec("DELETE FROM feeds");
    await env.DB.exec("DELETE FROM folders");
  });

  it("フォルダとフィードを作り、新しいフィードの取得を積む", async () => {
    const { platform, enqueued } = createTestPlatform({ now: () => NOW });

    const result = await runImportFeeds(platform, [
      { url: "https://a.example/feed", folder: "Tech" },
      { url: "https://b.example/feed", folder: "Tech" },
      { url: "https://c.example/feed", folder: null },
    ]);

    expect(result).toEqual({ created: 3 });
    const folders = await listFolders(platform.db);
    expect(folders.map((folder) => folder.name)).toEqual(["Tech"]);
    const feeds = await listFeeds(platform.db);
    // 同じ時刻に登録したフィードの並びは決まっていないので、URL の順に並べて比べる
    const rows = feeds
      .map((feed) => [feed.url, feed.folderId, feed.nextFetchAt] as const)
      .sort(([a], [b]) => a.localeCompare(b));
    expect(rows).toEqual([
      ["https://a.example/feed", folders[0]?.id, NOW],
      ["https://b.example/feed", folders[0]?.id, NOW],
      ["https://c.example/feed", null, NOW],
    ]);
    expect(enqueued.map((job) => job.type)).toEqual(["fetch-feed", "fetch-feed", "fetch-feed"]);
  });

  it("もう一度実行しても増えず、取得も積まない", async () => {
    const { platform, enqueued } = createTestPlatform({ now: () => NOW });
    const entries = [{ url: "https://a.example/feed", folder: "Tech" }];
    await runImportFeeds(platform, entries);
    enqueued.length = 0;

    expect(await runImportFeeds(platform, entries)).toEqual({ created: 0 });
    expect(enqueued).toEqual([]);
    expect(await listFeeds(platform.db)).toHaveLength(1);
  });

  it("既存のフィードは、フォルダに入っていなければ入れ、入っていれば変えない", async () => {
    const { platform } = createTestPlatform({ now: () => NOW });
    await runImportFeeds(platform, [
      { url: "https://loose.example/feed", folder: null },
      { url: "https://sorted.example/feed", folder: "Mine" },
    ]);

    await runImportFeeds(platform, [
      { url: "https://loose.example/feed", folder: "Tech" },
      { url: "https://sorted.example/feed", folder: "Tech" },
    ]);

    const folders = new Map((await listFolders(platform.db)).map((f) => [f.id, f.name]));
    const byUrl = new Map(
      (await listFeeds(platform.db)).map((feed) => [feed.url, folders.get(feed.folderId ?? "")]),
    );
    expect(byUrl.get("https://loose.example/feed")).toBe("Tech");
    expect(byUrl.get("https://sorted.example/feed")).toBe("Mine");
  });

  it("D1 の変数の上限を超える件数でも、分けて書き込む", async () => {
    const { platform } = createTestPlatform({ now: () => NOW });
    const entries = Array.from({ length: 120 }, (_, i) => ({
      url: `https://f${i}.example/feed`,
      folder: `Folder ${i % 60}`,
    }));

    expect(await runImportFeeds(platform, entries)).toEqual({ created: 120 });
    expect(await listFolders(platform.db)).toHaveLength(60);
  });

  it("キューの中身が書き換えられていても、内部の URL は登録しない", async () => {
    const { platform } = createTestPlatform({ now: () => NOW });

    const result = await runImportFeeds(platform, [
      { url: "http://localhost/feed", folder: null },
      { url: "https://ok.example/feed", folder: null },
    ]);

    expect(result).toEqual({ created: 1 });
    expect((await listFeeds(platform.db)).map((feed) => feed.url)).toEqual([
      "https://ok.example/feed",
    ]);
  });
});
