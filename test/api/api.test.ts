import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import spec from "../../spec/openapi.json";
import { insertArticles } from "../../src/db/articles";
import { deliverNewArticles } from "../../src/db/inbox";
import { createTestPlatform, requestApp, subscribeFeed } from "../helpers";

type Json = Record<string, unknown>;
const json = async (res: Response) => (await res.json()) as Json;

describe("認証", () => {
  it.each([
    ["ヘッダーなし", null],
    ["違うトークン", "wrong-token"],
  ])("%s なら 401", async (_label, token) => {
    const { platform } = createTestPlatform();
    const res = await requestApp(platform, "/api/v1/feeds", { token });

    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
    expect(await json(res)).toMatchObject({ error: { code: "unauthorized" } });
  });

  it("サーバーが返す定義は、コミットした spec/openapi.json と一致する", async () => {
    const { platform } = createTestPlatform();
    const res = await requestApp(platform, "/api/v1/openapi.json", { token: null });

    expect(await res.json()).toEqual(spec);
  });

  it("OpenAPI の定義は認証なしで読める", async () => {
    const { platform } = createTestPlatform();
    const res = await requestApp(platform, "/api/v1/openapi.json", { token: null });

    expect(res.status).toBe(200);
    const doc = await json(res);
    expect(doc).toMatchObject({
      openapi: "3.1.0",
      info: { title: "Sendo API" },
      servers: [{ url: "/api/v1" }],
    });
    expect(Object.keys(doc.paths as Json)).toEqual(expect.arrayContaining(["/feeds", "/articles"]));
  });
});

describe("GET /api/v1/articles", () => {
  async function seed() {
    await env.DB.exec("DELETE FROM feeds");
    const { platform } = createTestPlatform();
    const base = new Date("2026-11-01T00:00:00Z").getTime();
    const ids: Record<string, string> = {};
    for (const name of ["a", "b"]) {
      const feed = await subscribeFeed(platform, { now: new Date(base) });
      ids[name] = feed.id;
    }
    // フィード a に 5 件、b に 2 件。同じ時刻の記事も混ぜる
    const rows = [
      ...[0, 1, 2, 2, 3].map((hour, i) => ({ feed: "a", hour, guid: `a${i}` })),
      ...[1, 4].map((hour, i) => ({ feed: "b", hour, guid: `b${i}` })),
    ].map(({ feed, hour, guid }) => ({
      id: guid,
      feedId: ids[feed] ?? "",
      guid,
      url: `https://example.com/${guid}`,
      title: guid,
      summary: null,
      author: null,
      publishedAt: new Date(base + hour * 3_600_000),
      createdAt: new Date(base),
    }));
    await insertArticles(platform.db, rows);
    for (const feedId of Object.values(ids)) await deliverNewArticles(platform.db, { feedId });
    return { platform, ids };
  }

  it("新しい順に、ページを送って最後まで重複なく返す", async () => {
    const { platform } = await seed();
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const query = cursor === null ? "limit=3" : `limit=3&cursor=${cursor}`;
      const body = (await json(await requestApp(platform, `/api/v1/articles?${query}`))) as {
        items: { id: string }[];
        nextCursor: string | null;
      };
      seen.push(...body.items.map((item) => item.id));
      cursor = body.nextCursor;
      if (cursor === null) break;
    }

    expect(seen).toEqual(["b1", "a4", "a3", "a2", "b0", "a1", "a0"]);
  });

  it("公開日時を開始以上・終了未満で絞り、同じ期間でページを送れる", async () => {
    const { platform, ids } = await seed();
    const query = new URLSearchParams({
      since: "2026-11-01T10:00:00+09:00",
      until: "2026-11-01T12:00:00+09:00",
      feedId: ids.a ?? "",
      state: "unread",
      limit: "1",
    });
    const seen: string[] = [];
    for (let page = 0; page < 5; page++) {
      const res = await requestApp(platform, `/api/v1/articles?${query}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: { id: string }[]; nextCursor: string | null };
      seen.push(...body.items.map((item) => item.id));
      if (body.nextCursor === null) break;
      query.set("cursor", body.nextCursor);
    }
    expect(seen).toEqual(["a3", "a2", "a1"]);
    for (const [key, value, expected] of [
      ["since", "2026-11-01T04:00:00Z", ["b1"]],
      ["until", "2026-11-01T01:00:00Z", ["a0"]],
    ] as const) {
      const body = (await (
        await requestApp(platform, `/api/v1/articles?${new URLSearchParams({ [key]: value })}`)
      ).json()) as { items: { id: string }[] };
      expect(body.items.map((item) => item.id)).toEqual(expected);
    }
  });

  it("不正な日時・タイムゾーンのない日時・空か逆順の期間は 400", async () => {
    const { platform } = createTestPlatform();
    for (const period of [
      { since: "2026-02-30T00:00:00Z" },
      { until: "2026-11-01T00:00:00" },
      { since: "2026-11-01T00:00:00Z", until: "2026-11-01T00:00:00Z" },
      { since: "2026-11-01T10:00:00+09:00", until: "2026-11-01T00:00:00Z" },
    ]) {
      const res = await requestApp(platform, `/api/v1/articles?${new URLSearchParams(period)}`);
      expect(res.status).toBe(400);
    }
  });

  it("1970 年より前の記事をまたいでも、ページを送れる", async () => {
    await env.DB.exec("DELETE FROM feeds");
    const { platform } = createTestPlatform();
    const feed = await subscribeFeed(platform, {});
    await insertArticles(
      platform.db,
      ["1965-01-01", "1960-01-01", "1955-01-01"].map((date, i) => ({
        id: `old${i}`,
        feedId: feed.id,
        guid: `old${i}`,
        url: null,
        title: null,
        summary: null,
        author: null,
        publishedAt: new Date(`${date}T00:00:00Z`),
        createdAt: new Date(Date.now() - 1000),
      })),
    );
    await deliverNewArticles(platform.db, { feedId: feed.id });

    const first = (await json(await requestApp(platform, "/api/v1/articles?limit=1"))) as {
      nextCursor: string;
    };
    const second = await requestApp(
      platform,
      `/api/v1/articles?limit=2&cursor=${first.nextCursor}`,
    );

    expect(second.status).toBe(200);
    const body = (await json(second)) as { items: { id: string }[] };
    expect(body.items.map((item) => item.id)).toEqual(["old1", "old2"]);
  });

  it("フィードで絞り込める", async () => {
    const { platform, ids } = await seed();
    const res = await requestApp(platform, `/api/v1/articles?feedId=${ids.b}`);
    const body = (await json(res)) as { items: { id: string }[]; nextCursor: string | null };

    expect(body.items.map((item) => item.id)).toEqual(["b1", "b0"]);
    expect(body.nextCursor).toBeNull();
  });

  it.each([
    ["limit が大きすぎる", "limit=101"],
    ["limit が 0", "limit=0"],
    ["cursor が壊れている", "cursor=not-a-cursor"],
  ])("%s なら 400", async (_label, query) => {
    const { platform } = createTestPlatform();
    const res = await requestApp(platform, `/api/v1/articles?${query}`);

    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ error: { code: "invalid_request" } });
  });
});
