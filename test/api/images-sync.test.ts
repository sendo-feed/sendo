import { describe, expect, it } from "vitest";
import { appSecrets } from "../../src/db/schema";
import { ICON_CHECK_INTERVAL_MS, runFetchFeed } from "../../src/jobs/fetch-feed";
import { PNG } from "../fixtures/images";
import { createTestPlatform, createUser, fakeFetch, requestApp, subscribeFeed } from "../helpers";

/*
 * 記事のサムネイルとフィードのアイコンが、取得のジョブから REST API と差分同期まで届くこと
 * （docs/decisions/images.md の 7〜10）。
 */

type Sync = {
  cursor: string;
  feeds: { id: string; iconUrl: string | null; deleted: boolean }[];
  articles: { id: string; title?: string; thumbnailUrl?: string | null; deleted: boolean }[];
};

const NOW = new Date("2026-11-14T00:00:00Z");

async function setup() {
  const user = await createUser();
  const site = `https://${crypto.randomUUID()}.example.com`;
  const state = { icon: "/icon-1.png", now: NOW };
  const fake = fakeFetch((url) => {
    if (url.pathname === "/feed.xml") {
      return new Response(`<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel>
        <title>Blog</title><link>${site}/</link>
        <item><title>With</title><guid>1</guid><media:thumbnail url="${site}/thumb.jpg?a=1&amp;b=2"/></item>
        <item><title>Without</title><guid>2</guid></item>
      </channel></rss>`);
    }
    if (url.pathname === "/") return new Response(`<link rel="icon" href="${state.icon}">`);
    if (url.pathname.endsWith(".png") || url.pathname.endsWith(".jpg")) return new Response(PNG);
    return new Response(null, { status: 404 });
  });
  const { platform } = createTestPlatform({ fetch: fake.fetch, now: () => state.now });
  const feed = await subscribeFeed(platform, {
    url: `${site}/feed.xml`,
    userId: user.id,
    now: NOW,
  });
  const get = async <T>(path: string) => {
    const res = await requestApp(platform, path, { token: user.token });
    expect(res.status).toBe(200);
    return (await res.json()) as T;
  };
  return { platform, feed, site, state, user, get, calls: fake.calls };
}

describe("サムネイルとアイコンの配り方", () => {
  it("差分同期に、中継を通る URL として届き、その URL で画像が開ける", async () => {
    const { platform, feed, site, user, get, calls } = await setup();
    await runFetchFeed(platform, feed.id);

    const sync = await get<Sync>("/api/v1/sync");
    const withThumbnail = sync.articles.find((article) => article.title === "With");
    const without = sync.articles.find((article) => article.title === "Without");
    expect(without?.thumbnailUrl).toBeNull();

    const thumbnailUrl = withThumbnail?.thumbnailUrl ?? "";
    expect(thumbnailUrl).toMatch(/^\/api\/v1\/images\?url=/);
    expect(new URL(thumbnailUrl, "https://reader.example").searchParams.get("url")).toBe(
      `${site}/thumb.jpg?a=1&b=2`,
    );

    const iconUrl = sync.feeds[0]?.iconUrl ?? "";
    expect(new URL(iconUrl, "https://reader.example").searchParams.get("url")).toBe(
      `${site}/icon-1.png`,
    );

    for (const url of [thumbnailUrl, iconUrl]) {
      const res = await requestApp(platform, url, { token: user.token });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/png");
      await res.body?.cancel();
    }
    expect(calls.at(-2)?.url).toBe(`${site}/thumb.jpg?a=1&b=2`);
  });

  it("REST API の記事とフィードにも、同じ URL が載る", async () => {
    const { platform, feed, get } = await setup();
    await runFetchFeed(platform, feed.id);

    const sync = await get<Sync>("/api/v1/sync");
    const articles = await get<{ items: { id: string; thumbnailUrl: string | null }[] }>(
      "/api/v1/articles",
    );
    for (const article of articles.items) {
      expect(article.thumbnailUrl).toBe(
        sync.articles.find((synced) => synced.id === article.id)?.thumbnailUrl,
      );
    }
    expect(articles.items.filter((article) => article.thumbnailUrl !== null)).toHaveLength(1);

    const list = await get<{ items: { id: string; iconUrl: string | null }[] }>("/api/v1/feeds");
    expect(list.items[0]?.iconUrl).toBe(sync.feeds[0]?.iconUrl);
    expect(list.items[0]?.iconUrl).not.toBeNull();
  });

  it("アイコンが変わると、購読の変更として差分同期に届く。変わらなければ届かない", async () => {
    const { platform, feed, site, state, get } = await setup();
    await runFetchFeed(platform, feed.id);
    const first = await get<Sync>("/api/v1/sync");

    // 30 日たって探し直しても、同じアイコンなら何も届かない
    state.now = new Date(NOW.getTime() + ICON_CHECK_INTERVAL_MS);
    await runFetchFeed(platform, feed.id);
    const unchanged = await get<Sync>(`/api/v1/sync?cursor=${first.cursor}`);
    expect(unchanged.feeds).toEqual([]);

    state.icon = "/icon-2.png";
    state.now = new Date(NOW.getTime() + 2 * ICON_CHECK_INTERVAL_MS);
    await runFetchFeed(platform, feed.id);
    const changed = await get<Sync>(`/api/v1/sync?cursor=${unchanged.cursor}`);
    expect(changed.feeds).toHaveLength(1);
    expect(
      new URL(changed.feeds[0]?.iconUrl ?? "", "https://reader.example").searchParams.get("url"),
    ).toBe(`${site}/icon-2.png`);
  });

  it("サムネイルもアイコンもなければ、鍵を読みも作りもしない（null を返すだけ）", async () => {
    const user = await createUser();
    const { platform } = createTestPlatform();
    await subscribeFeed(platform, { userId: user.id });
    await platform.db.delete(appSecrets).run();

    const res = await requestApp(platform, "/api/v1/sync", { token: user.token });
    const sync = (await res.json()) as Sync;
    expect(sync.feeds[0]?.iconUrl).toBeNull();
    expect(await platform.db.select().from(appSecrets).all()).toEqual([]);
  });
});
