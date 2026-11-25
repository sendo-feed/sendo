import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import { insertArticles } from "../../src/db/articles";
import { createFolder, deleteFolder, listFolders } from "../../src/db/folders";
import { setArticlesState } from "../../src/db/inbox";
import { getSubscription } from "../../src/db/subscriptions";
import { createAccessToken, type McpScope } from "../../src/db/tokens";
import type { Platform } from "../../src/platform";
import { testDb } from "../db";
import {
  addToInbox,
  createSessionHeaders,
  createTestPlatform,
  createUser,
  fakeFetch,
  recordingSyncUpdates,
  requestApp,
  statementHook,
  subscribeFeed,
} from "../helpers";

const MCP_URL = "https://sendo.example.com/mcp";

/** MCP 用のトークンを発行する */
async function mcpToken(userId: string, scopes: McpScope[]) {
  const { platform } = createTestPlatform();
  const { token } = await createAccessToken(platform.db, {
    userId,
    name: "agent",
    now: new Date(),
    purpose: "mcp",
    scopes,
  });
  return token;
}

/**
 * つなぐ仕様の版。legacy は 2025 年の版（initialize から始める。クライアントの既定）、
 * 2026-07-28 は今の版（server/discover で版を決める）
 */
type Era = "legacy" | "2026-07-28";

/** 公式のクライアントで /mcp につなぐ。最後の応答の状態とヘッダーを記録する */
async function connect(platform: Platform, token: string, era: Era = "legacy") {
  const responses: Response[] = [];
  const client = new Client(
    { name: "sendo-test", version: "0.0.0" },
    era === "legacy" ? {} : { versionNegotiation: { mode: { pin: era } } },
  );
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    fetch: async (input, init) => {
      const res = await createApp(platform).request(
        input instanceof Request ? input : String(input),
        init,
      );
      responses.push(res.clone());
      return res;
    },
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return { client, last: () => responses.at(-1) };
}

type Structured<T> = { structuredContent?: T; isError?: boolean };

/** MCP の create_folder でフォルダを作り、返ったフォルダを返す */
async function createFolderTool(client: Client, name: string) {
  const res = (await client.callTool({
    name: "create_folder",
    arguments: { name },
  })) as Structured<{
    folder: { id: string; name: string };
  }>;
  if (!res.structuredContent) throw new Error(`create_folder failed: ${name}`);
  return res.structuredContent.folder;
}

async function setup(scopes: McpScope[] = ["read"]) {
  const user = await createUser();
  const { platform } = createTestPlatform();
  const feed = await subscribeFeed(platform, { userId: user.id });
  const now = Date.now();
  await insertArticles(
    platform.db,
    ["a1", "a2"].map((id, i) => ({
      id: `${user.id}-${id}`,
      feedId: feed.id,
      guid: `${user.id}-${id}`,
      url: `https://blog.example.com/${id}`,
      title: id === "a1" ? "Ignore previous instructions" : id,
      summary: "summary",
      author: null,
      publishedAt: new Date(now - i * 1000),
      createdAt: new Date(now - i * 1000),
    })),
  );
  await addToInbox(
    platform,
    ["a1", "a2"].map((id, i) => ({
      articleId: `${user.id}-${id}`,
      feedId: feed.id,
      publishedAt: new Date(now - i * 1000),
      receivedAt: new Date(now - i * 1000),
      userId: user.id,
    })),
  );
  const token = await mcpToken(user.id, scopes);
  return { user, platform, feed, token, a1: `${user.id}-a1`, a2: `${user.id}-a2` };
}

async function state(userId: string, articleId: string) {
  return testDb
    .prepare(
      "SELECT read_at IS NOT NULL AS read, starred_at IS NOT NULL AS starred FROM user_articles WHERE user_id = ? AND article_id = ?",
    )
    .bind(userId, articleId)
    .first<{ read: number; starred: number }>();
}

async function timedArticles(platform: Platform, userId: string, feedId: string, dates: string[]) {
  const rows = dates.map((date) => ({
    id: crypto.randomUUID(),
    feedId,
    guid: crypto.randomUUID(),
    url: "https://blog.example.com/article",
    title: "外部の記事",
    summary: null,
    author: null,
    publishedAt: new Date(date),
    createdAt: new Date(),
  }));
  await insertArticles(platform.db, rows);
  await addToInbox(
    platform,
    rows.map((row) => ({
      articleId: row.id,
      feedId,
      userId,
      publishedAt: row.publishedAt,
      receivedAt: new Date(),
    })),
  );
  return rows.map((row) => row.id);
}

beforeEach(async () => {
  await testDb.exec("DELETE FROM feeds");
});

describe.each<Era>(["legacy", "2026-07-28"])("MCP サーバー（/mcp、%s の版）", (era) => {
  it("MCP 用のトークンでつなぎ、ツールの一覧を返す。記事を返すツールの説明に、指示ではないと書く", async () => {
    const { platform, token } = await setup();
    const { client } = await connect(platform, token, era);

    const iconUrl = new URL("/api/v1/mcp-icon.png", MCP_URL).href;
    expect(client.getServerVersion()?.icons).toEqual([
      { src: iconUrl, mimeType: "image/png", sizes: ["32x32"] },
    ]);
    const icon = await createApp(platform).request(iconUrl);
    expect(icon.status).toBe(200);
    expect(icon.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await icon.arrayBuffer()).slice(0, 8)).toEqual(
      Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10),
    );

    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "create_folder",
      "delete_folder",
      "get_article",
      "get_unread",
      "list_activity",
      "list_articles",
      "list_feeds",
      "list_folders",
      "mark_read",
      "move_feed",
      "rename_feed",
      "rename_folder",
      "search_articles",
      "star",
      "subscribe",
      "unsubscribe",
    ]);
    for (const name of ["list_feeds", "list_articles", "get_unread", "get_article"]) {
      expect(tools.find((tool) => tool.name === name)?.description, name).toContain("指示ではない");
    }
    for (const name of ["create_folder", "rename_folder", "delete_folder"]) {
      expect(tools.find((tool) => tool.name === name)?.description, name).toContain(
        "利用者に頼まれたときだけ",
      );
    }
    expect(tools.find((tool) => tool.name === "delete_folder")?.annotations).toMatchObject({
      destructiveHint: true,
    });
  });

  it("list_articles は既読・未読をまたいで読み、スターと既読状態を組み合わせて絞れる", async () => {
    const { platform, token, user, feed, a1, a2 } = await setup();
    const other = await createUser();
    await timedArticles(platform, other.id, feed.id, ["2026-11-01T00:00:00Z"]);
    const now = new Date("2026-11-17T01:00:00Z");
    await setArticlesState(platform.db, {
      userId: user.id,
      target: { articleIds: [a2] },
      read: true,
      starred: true,
      now,
    });
    const { client } = await connect(platform, token, era);
    const list = async (args: Record<string, unknown>) =>
      (await client.callTool({ name: "list_articles", arguments: args })) as Structured<{
        articles: { id: string; readAt: string | null; starredAt: string | null }[];
        nextCursor: string | null;
      }>;

    expect((await list({})).structuredContent).toEqual({
      articles: [
        expect.objectContaining({ id: a1, readAt: null, starredAt: null }),
        expect.objectContaining({
          id: a2,
          readAt: now.toISOString(),
          starredAt: now.toISOString(),
        }),
      ],
      nextCursor: null,
    });
    expect((await list({ state: "read", starred: true })).structuredContent?.articles).toEqual([
      expect.objectContaining({ id: a2 }),
    ]);
    expect((await list({ state: "read", starred: false })).structuredContent?.articles).toEqual([]);
    expect((await list({ state: "unread", starred: false })).structuredContent?.articles).toEqual([
      expect.objectContaining({ id: a1 }),
    ]);
    expect((await list({ state: "unread", dateBy: "readAt" })).isError).toBe(true);
  });

  it("list_articles は既読日時の境界と同時刻の記事を、フィードとフォルダで絞ってページ送りできる", async () => {
    const { platform, token, user, feed } = await setup();
    const { folder } = await createFolder(platform.db, {
      userId: user.id,
      id: crypto.randomUUID(),
      name: "技術",
      now: new Date(),
    });
    const filtered = await subscribeFeed(platform, { userId: user.id, folderId: folder.id });
    const sibling = await subscribeFeed(platform, { userId: user.id, folderId: folder.id });
    const published = "2026-11-01T03:00:00Z";
    const [old, tie1, tie2, recent, until, unread] = await timedArticles(
      platform,
      user.id,
      filtered.id,
      [published, published, published, "2026-10-01T03:00:00Z", published, published],
    );
    const outside = await timedArticles(platform, user.id, feed.id, [published]);
    const insideOtherFeed = await timedArticles(platform, user.id, sibling.id, [published]);
    const since = "2026-11-17T10:00:00+09:00";
    const untilDate = "2026-11-17T11:00:00+09:00";
    for (const [ids, date] of [
      [[old], "2026-11-17T00:59:59.999Z"],
      [[tie1, tie2, ...outside, ...insideOtherFeed], since],
      [[recent], "2026-11-17T01:30:00Z"],
      [[until], untilDate],
    ] as const) {
      await setArticlesState(platform.db, {
        userId: user.id,
        target: { articleIds: ids.filter((id) => id !== undefined) },
        read: true,
        now: new Date(date),
      });
    }
    const { client } = await connect(platform, token, era);
    const feeds = (await client.callTool({ name: "list_feeds", arguments: {} })) as Structured<{
      feeds: { id: string; folderId: string | null }[];
    }>;
    expect(feeds.structuredContent?.feeds).toContainEqual(
      expect.objectContaining({ id: filtered.id, folderId: folder.id }),
    );
    const query = {
      dateBy: "readAt",
      since,
      until: untilDate,
      folderId: folder.id,
      feedId: filtered.id,
    };
    const list = async (args: Record<string, unknown>) =>
      (await client.callTool({ name: "list_articles", arguments: args })) as Structured<{
        articles: { id: string }[];
        nextCursor: string | null;
      }>;
    const first = await list({ ...query, limit: 1 });
    expect(first.structuredContent?.articles.map((a) => a.id)).toEqual([recent]);
    expect(first.structuredContent?.nextCursor).toEqual(expect.any(String));
    const cursor = first.structuredContent?.nextCursor;
    const [newerTie, olderTie] = [tie1, tie2].sort().reverse();
    const second = await list({ ...query, limit: 1, cursor });
    expect(second.structuredContent?.articles.map((a) => a.id)).toEqual([newerTie]);
    expect(second.structuredContent?.nextCursor).toEqual(expect.any(String));
    const third = await list({ ...query, cursor: second.structuredContent?.nextCursor });
    expect(third.structuredContent?.articles.map((a) => a.id)).toEqual([olderTie]);
    expect(third.structuredContent?.nextCursor).toBeNull();
    expect((await list({ ...query, dateBy: "publishedAt", cursor })).isError).toBe(true);
    expect((await list({ ...query, since: untilDate })).isError).toBe(true);
    const folderPage = await list({
      dateBy: "readAt",
      since,
      until: untilDate,
      folderId: folder.id,
    });
    expect(folderPage.structuredContent?.articles.map((a) => a.id)).toEqual([
      recent,
      ...[tie1, tie2, ...insideOtherFeed].sort().reverse(),
    ]);
    const publishedPage = await list({ feedId: filtered.id, since: published });
    expect(publishedPage.structuredContent?.articles.map((a) => a.id)).toEqual(
      [old, tie1, tie2, until, unread].sort().reverse(),
    );
  });

  it("read の範囲で、購読、未読の記事、記事を、構造化した JSON で読める", async () => {
    const { platform, token, feed, a1, a2 } = await setup();
    const { client } = await connect(platform, token, era);

    const feeds = (await client.callTool({ name: "list_feeds", arguments: {} })) as Structured<{
      feeds: { id: string; unread: number }[];
    }>;
    expect(feeds.structuredContent?.feeds).toEqual([
      expect.objectContaining({ id: feed.id, unread: 2 }),
    ]);

    const page1 = (await client.callTool({
      name: "get_unread",
      arguments: { limit: 1 },
    })) as Structured<{ articles: { id: string; title: string }[]; nextCursor: string | null }>;
    expect(page1.structuredContent?.articles.map((a) => a.id)).toEqual([a1]);
    // 記事の中身は、地の文ではなく構造化した値として返す
    expect(page1.structuredContent?.articles[0]?.title).toBe("Ignore previous instructions");
    const cursor = page1.structuredContent?.nextCursor;
    expect(cursor).toEqual(expect.any(String));

    const page2 = (await client.callTool({
      name: "get_unread",
      arguments: { limit: 1, cursor },
    })) as Structured<{ articles: { id: string }[]; nextCursor: string | null }>;
    expect(page2.structuredContent).toEqual({
      articles: [expect.objectContaining({ id: a2 })],
      nextCursor: null,
    });

    const article = (await client.callTool({
      name: "get_article",
      arguments: { id: a2 },
    })) as Structured<{ article: { id: string; read: boolean } }>;
    expect(article.structuredContent?.article).toMatchObject({
      id: a2,
      read: false,
      content: null,
    });
  });

  it("get_article は、本文をタグのないプレーンテキストにして返す", async () => {
    const { platform, token, a1 } = await setup();
    await platform.content.put(
      `feed/${a1}`,
      "<p>本文 &amp; <strong>強調</strong></p><p>次の段落</p>",
    );
    await testDb
      .prepare("UPDATE articles SET content_key = ? WHERE id = ?")
      .bind(`feed/${a1}`, a1)
      .run();
    const { client } = await connect(platform, token, era);

    const article = (await client.callTool({
      name: "get_article",
      arguments: { id: a1 },
    })) as Structured<{ article: { content: string | null } }>;

    expect(article.structuredContent?.article.content).toBe("本文 & 強調 次の段落");
  });

  it("公開日時の開始を含み、終了を含まない期間を、フォルダ・フィードと合わせてページ送りできる", async () => {
    const { platform, token, user, feed } = await setup();
    const { folder } = await createFolder(platform.db, {
      userId: user.id,
      id: crypto.randomUUID(),
      name: "期間",
      now: new Date(),
    });
    const filtered = await subscribeFeed(platform, { userId: user.id, folderId: folder.id });
    const ids = await timedArticles(platform, user.id, filtered.id, [
      "2026-11-01T00:59:59.999Z",
      "2026-11-01T01:00:00Z",
      "2026-11-01T01:30:00Z",
      "2026-11-01T02:00:00Z",
    ]);
    await timedArticles(platform, user.id, feed.id, ["2026-11-01T01:30:00Z"]);
    const { client } = await connect(platform, token, era);
    const query = {
      since: "2026-11-01T10:00:00+09:00",
      until: "2026-11-01T11:00:00+09:00",
      folderId: folder.id,
      feedId: filtered.id,
      limit: 1,
    };
    const first = (await client.callTool({ name: "get_unread", arguments: query })) as Structured<{
      articles: { id: string }[];
      nextCursor: string | null;
    }>;
    expect(first.structuredContent?.articles.map((a) => a.id)).toEqual([ids[2]]);
    expect(first.structuredContent?.nextCursor).toEqual(expect.any(String));
    const second = (await client.callTool({
      name: "get_unread",
      arguments: { ...query, cursor: first.structuredContent?.nextCursor },
    })) as Structured<{ articles: { id: string }[]; nextCursor: string | null }>;
    expect(second.structuredContent).toEqual({
      articles: [expect.objectContaining({ id: ids[1] })],
      nextCursor: null,
    });

    const sinceOnly = (await client.callTool({
      name: "get_unread",
      arguments: { feedId: filtered.id, since: query.until },
    })) as Structured<{ articles: { id: string }[] }>;
    expect(sinceOnly.structuredContent?.articles.map((a) => a.id)).toEqual([ids[3]]);
    const untilOnly = (await client.callTool({
      name: "get_unread",
      arguments: { feedId: filtered.id, until: query.since },
    })) as Structured<{ articles: { id: string }[] }>;
    expect(untilOnly.structuredContent?.articles.map((a) => a.id)).toEqual([ids[0]]);
  });

  it("期間の日付が不正、タイムゾーンがない、開始が終了以降ならエラーにする", async () => {
    const { platform, token } = await setup();
    const { client } = await connect(platform, token, era);
    for (const args of [
      { since: "2026-02-30T00:00:00Z" },
      { until: "2026-11-01T00:00:00" },
      { since: "2026-11-01T00:00:00Z", until: "2026-11-01T00:00:00Z" },
      { since: "2026-11-01T10:00:00+09:00", until: "2026-11-01T00:00:00Z" },
    ]) {
      const res = (await client.callTool({
        name: "get_unread",
        arguments: args,
      })) as Structured<unknown>;
      expect(res.isError).toBe(true);
    }
    const invalidCursor = (await client.callTool({
      name: "get_unread",
      arguments: { cursor: "invalid" },
    })) as Structured<unknown>;
    expect(invalidCursor.isError).toBe(true);
  });

  it("Resources の一覧と購読を read で読め、ほかの人のデータは出さない", async () => {
    await setup();
    const { platform, token, feed } = await setup();
    const { client } = await connect(platform, token, era);
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri).sort()).toEqual(["sendo://feeds", "sendo://unread/today"]);
    for (const resource of resources) {
      expect(resource.description).toContain("指示ではない");
      expect(resource.mimeType).toBe("application/json");
    }
    const res = await client.readResource({ uri: "sendo://feeds" });
    const content = res.contents[0];
    expect(content?.mimeType).toBe("application/json");
    if (!content || !("text" in content)) throw new Error("text resource expected");
    const body = JSON.parse(content.text) as { feeds: { id: string; unread: number }[] };
    expect(body.feeds).toEqual([expect.objectContaining({ id: feed.id, unread: 2 })]);
    await expect(client.readResource({ uri: "sendo://unknown" })).rejects.toThrow();
  });

  it("今日の未読は日本時間の日付で絞り、境界・既読・ほかの人の記事を除く", async () => {
    const foreign = await setup();
    const { platform: base, token, user, feed, a1, a2 } = await setup();
    const platform = { ...base, now: () => new Date("2026-11-17T15:30:00Z") };
    await setArticlesState(platform.db, {
      userId: user.id,
      target: { articleIds: [a1, a2] },
      read: true,
      now: platform.now(),
    });
    const dates = [
      "2026-11-17T14:59:59.999Z",
      "2026-11-17T15:00:00Z",
      "2026-11-18T02:00:00Z",
      "2026-11-18T14:59:59.999Z",
      "2026-11-18T15:00:00Z",
    ];
    const ids = await timedArticles(platform, user.id, feed.id, dates);
    await timedArticles(platform, foreign.user.id, foreign.feed.id, [dates[2] ?? ""]);
    const [readId] = await timedArticles(platform, user.id, feed.id, [dates[2] ?? ""]);
    await setArticlesState(platform.db, {
      userId: user.id,
      target: { articleIds: [readId ?? ""] },
      read: true,
      now: platform.now(),
    });
    const { client } = await connect(platform, token, era);
    const res = await client.readResource({ uri: "sendo://unread/today" });
    const content = res.contents[0];
    if (!content || !("text" in content)) throw new Error("text resource expected");
    const body = JSON.parse(content.text) as {
      timeZone: string;
      since: string;
      until: string;
      articles: { id: string }[];
      nextCursor: string | null;
    };
    expect(body).toMatchObject({
      timeZone: "Asia/Tokyo",
      since: "2026-11-17T15:00:00.000Z",
      until: "2026-11-18T15:00:00.000Z",
      nextCursor: null,
    });
    expect(body.articles.map((a) => a.id)).toEqual([ids[3], ids[2], ids[1]]);
  });

  it("今日の未読が 50 件を超えても、返した期間と cursor で続きを取れる", async () => {
    const { platform: base, token, user, feed, a1, a2 } = await setup();
    const platform = { ...base, now: () => new Date("2026-11-01T02:00:00Z") };
    await setArticlesState(platform.db, {
      userId: user.id,
      target: { articleIds: [a1, a2] },
      read: true,
      now: platform.now(),
    });
    const ids = await timedArticles(
      platform,
      user.id,
      feed.id,
      Array.from({ length: 52 }, () => "2026-11-01T01:00:00Z"),
    );
    const { client } = await connect(platform, token, era);
    const res = await client.readResource({ uri: "sendo://unread/today" });
    const content = res.contents[0];
    if (!content || !("text" in content)) throw new Error("text resource expected");
    const body = JSON.parse(content.text) as {
      since: string;
      until: string;
      articles: { id: string }[];
      nextCursor: string | null;
    };
    expect(body.articles).toHaveLength(50);
    expect(body.nextCursor).toEqual(expect.any(String));
    const rest = (await client.callTool({
      name: "get_unread",
      arguments: { since: body.since, until: body.until, cursor: body.nextCursor },
    })) as Structured<{ articles: { id: string }[]; nextCursor: string | null }>;
    expect(rest.structuredContent?.nextCursor).toBeNull();
    const seen = [...body.articles, ...(rest.structuredContent?.articles ?? [])].map((a) => a.id);
    expect(seen).toHaveLength(52);
    expect(new Set(seen)).toEqual(new Set(ids));
  });

  it("read だけのトークンで状態を変えるツールを呼ぶと、403 insufficient_scope（scope は read write）", async () => {
    const { user, platform, token, feed, a1 } = await setup(["read"]);
    const { folder } = await createFolder(platform.db, {
      userId: user.id,
      id: crypto.randomUUID(),
      name: "技術",
      now: new Date(),
    });
    const { client, last } = await connect(platform, token, era);

    const folders = await client.callTool({ name: "list_folders", arguments: {} });
    expect(folders.structuredContent).toEqual({ folders: [{ id: folder.id, name: "技術" }] });
    for (const call of [
      { name: "mark_read", arguments: { ids: [a1] } },
      { name: "move_feed", arguments: { feedId: feed.id, folderId: folder.id } },
      { name: "rename_feed", arguments: { feedId: feed.id, displayName: "ニュース" } },
      { name: "create_folder", arguments: { name: "経済" } },
      { name: "rename_folder", arguments: { folderId: folder.id, name: "経済" } },
      { name: "delete_folder", arguments: { folderId: folder.id } },
    ]) {
      await expect(client.callTool(call)).rejects.toThrow();
      const res = last();
      expect(res?.status).toBe(403);
      const challenge = res?.headers.get("www-authenticate") ?? "";
      expect(challenge).toContain('error="insufficient_scope"');
      expect(challenge).toContain('scope="read write"');
    }
    expect(await state(user.id, a1)).toEqual({ read: 0, starred: 0 });
    expect(await getSubscription(platform.db, { userId: user.id, feedId: feed.id })).toMatchObject({
      folderId: null,
    });
    expect(await listFolders(platform.db, user.id)).toEqual([
      expect.objectContaining({ id: folder.id, name: "技術" }),
    ]);
  });

  it("subscribe で取得先が 502 を返したら、時間をおいて試せるとツールのエラーで返す", async () => {
    const { token } = await setup(["read", "write"]);
    const { fetch } = fakeFetch(() => new Response("bad gateway", { status: 502 }));
    const { platform } = createTestPlatform({ fetch });
    const { client } = await connect(platform, token);

    const res = await client.callTool({
      name: "subscribe",
      arguments: { url: "https://hnrss.org/newest?q=Claude" },
    });

    expect(res).toMatchObject({
      isError: true,
      content: [
        {
          type: "text",
          text: "cannot subscribe: unexpected status 502; the feed server may be temporarily unavailable, try again later",
        },
      ],
    });
  });

  it("write の範囲で、既読・スター・購読・購読をやめるを使え、REST API にも届く", async () => {
    const { user, token, feed, a1, a2 } = await setup(["read", "write"]);
    const rss =
      '<rss version="2.0"><channel><title>New</title><link>https://new.example.com/</link></channel></rss>';
    const { fetch } = fakeFetch(
      () => new Response(rss, { headers: { "content-type": "application/rss+xml" } }),
    );
    const { platform } = createTestPlatform({ fetch });
    const { folder } = await createFolder(platform.db, {
      userId: user.id,
      id: crypto.randomUUID(),
      name: "技術",
      now: new Date(),
    });
    const { client } = await connect(platform, token, era);

    const read = (await client.callTool({
      name: "mark_read",
      arguments: { ids: [a1, a2] },
    })) as Structured<{ updated: number }>;
    expect(read.structuredContent).toEqual({ updated: 2 });
    await client.callTool({ name: "mark_read", arguments: { ids: [a2], read: false } });
    await client.callTool({ name: "star", arguments: { ids: [a1] } });
    expect(await state(user.id, a1)).toEqual({ read: 1, starred: 1 });
    expect(await state(user.id, a2)).toEqual({ read: 0, starred: 0 });

    const subscribed = (await client.callTool({
      name: "subscribe",
      arguments: { url: "https://new.example.com/feed.xml", folderId: folder.id },
    })) as Structured<{ feed: { id: string; title: string }; created: boolean }>;
    expect(subscribed.structuredContent).toMatchObject({ feed: { title: "New" }, created: true });

    const left = (await client.callTool({
      name: "unsubscribe",
      arguments: { feedId: feed.id },
    })) as Structured<{ unsubscribed: boolean }>;
    expect(left.structuredContent).toEqual({ unsubscribed: true });

    const feeds = (await (
      await requestApp(platform, "/api/v1/feeds", { token: user.token })
    ).json()) as {
      items: { id: string; folderId: string | null }[];
    };
    expect(feeds.items).toEqual([
      expect.objectContaining({ id: subscribed.structuredContent?.feed.id, folderId: folder.id }),
    ]);
  });

  it("空のフォルダを一覧から選んで移動し、無効な移動先では分類を維持する", async () => {
    const { platform, token, user, feed, a1 } = await setup(["read", "write"]);
    const other = await createUser();
    const otherFeed = await subscribeFeed(platform, { userId: other.id });
    const makeFolder = async (userId: string, name: string) =>
      (await createFolder(platform.db, { userId, name, id: crypto.randomUUID(), now: new Date() }))
        .folder;
    const tech = await makeFolder(user.id, "技術");
    const removed = await makeFolder(user.id, "削除済み");
    const foreign = await makeFolder(other.id, "他ユーザー");
    await deleteFolder(platform.db, { userId: user.id, id: removed.id, now: new Date() });
    const { client } = await connect(platform, token, era);
    const folders = await client.callTool({ name: "list_folders", arguments: {} });
    expect(folders.structuredContent).toEqual({ folders: [{ id: tech.id, name: "技術" }] });
    const initialSync = await requestApp(platform, "/api/v1/sync", { token: user.token });
    const { cursor } = (await initialSync.json()) as { cursor: string };

    const move = (feedId: string, folderId: string | null) =>
      client.callTool({ name: "move_feed", arguments: { feedId, folderId } });
    const moved = await move(feed.id, tech.id);
    expect(moved.structuredContent).toEqual({
      feed: { id: feed.id, folderId: tech.id, folder: "技術" },
    });

    for (const invalid of ["unknown-folder", removed.id, foreign.id]) {
      expect(await move(feed.id, invalid)).toMatchObject({
        isError: true,
        content: [{ type: "text", text: "folder not found" }],
      });
    }
    expect(await move(otherFeed.id, tech.id)).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "feed is not subscribed" }],
    });
    const feeds = await client.callTool({ name: "list_feeds", arguments: {} });
    expect(feeds.structuredContent).toEqual({
      feeds: [expect.objectContaining({ id: feed.id, folderId: tech.id, folder: "技術" })],
    });
    const delta = await requestApp(platform, `/api/v1/sync?cursor=${encodeURIComponent(cursor)}`, {
      token: user.token,
    });
    expect(await delta.json()).toMatchObject({
      feeds: [{ id: feed.id, folderId: tech.id, deleted: false }],
    });
    expect(
      await getSubscription(platform.db, { userId: other.id, feedId: otherFeed.id }),
    ).toMatchObject({
      folderId: null,
    });
    const unfiled = await move(feed.id, null);
    expect(unfiled.structuredContent).toEqual({
      feed: { id: feed.id, folderId: null, folder: null },
    });
    expect(await state(user.id, a1)).toEqual({ read: 0, starred: 0 });
  });

  it("rename_feed で表示名を設定・解除し、購読と記事の読み出しに反映する", async () => {
    const { platform, token, feed } = await setup(["read", "write"]);
    const { client } = await connect(platform, token, era);
    const rename = (feedId: string, displayName: string | null) =>
      client.callTool({ name: "rename_feed", arguments: { feedId, displayName } });

    expect((await rename(feed.id, " ニュース ")).structuredContent).toEqual({
      feed: { id: feed.id, displayName: "ニュース" },
    });
    expect((await client.callTool({ name: "list_feeds" })).structuredContent).toMatchObject({
      feeds: [{ id: feed.id, displayName: "ニュース" }],
    });
    expect((await client.callTool({ name: "get_unread" })).structuredContent).toMatchObject({
      articles: [{ feedTitle: "ニュース" }, { feedTitle: "ニュース" }],
    });
    expect((await rename(feed.id, null)).structuredContent).toEqual({
      feed: { id: feed.id, displayName: null },
    });
    expect(await rename("missing", "ニュース")).toMatchObject({ isError: true });
  });

  it("購読を変える書き込みのツールは、成功したときだけ開いている画面に知らせる", async () => {
    const { platform, token, feed, user } = await setup(["read", "write"]);
    const recording = recordingSyncUpdates();
    platform.syncUpdates = recording.syncUpdates;
    const { client } = await connect(platform, token, era);

    await client.callTool({ name: "list_feeds" });
    await client.callTool({
      name: "rename_feed",
      arguments: { feedId: "missing", displayName: "x" },
    });
    expect(recording.notified).toEqual([]);

    await client.callTool({
      name: "rename_feed",
      arguments: { feedId: feed.id, displayName: "x" },
    });
    await client.callTool({ name: "move_feed", arguments: { feedId: feed.id, folderId: null } });
    await client.callTool({ name: "unsubscribe", arguments: { feedId: feed.id } });
    expect(recording.notified).toEqual([user.id, user.id, user.id]);
  });

  it("mark_read と star は、受信箱の記事を指したときだけ、開いている画面に知らせる", async () => {
    const { platform, token, user, a1 } = await setup(["read", "write"]);
    const recording = recordingSyncUpdates();
    platform.syncUpdates = recording.syncUpdates;
    const { client } = await connect(platform, token, era);

    await client.callTool({ name: "mark_read", arguments: { ids: [a1] } });
    expect(recording.notified).toEqual([user.id]);
    // 受信箱にない記事だけなら、何も変えないので知らせない
    await client.callTool({ name: "star", arguments: { ids: ["missing"] } });
    expect(recording.notified).toEqual([user.id]);

    await client.callTool({ name: "star", arguments: { ids: [a1] } });
    expect(recording.notified).toEqual([user.id, user.id]);
  });

  it("create_folder で作ったフォルダを、一覧から選んで購読と移動の先に使える。同じ名前なら作らずに返す", async () => {
    const { user, token, feed } = await setup(["read", "write"]);
    const rss =
      '<rss version="2.0"><channel><title>New</title><link>https://new.example.com/</link></channel></rss>';
    const { fetch } = fakeFetch(
      () => new Response(rss, { headers: { "content-type": "application/rss+xml" } }),
    );
    const { platform } = createTestPlatform({ fetch });
    const { client } = await connect(platform, token, era);
    const create = (name: string) =>
      client.callTool({ name: "create_folder", arguments: { name } }) as Promise<
        Structured<{ folder: { id: string; name: string }; created: boolean }>
      >;

    const tech = await create("技術");
    expect(tech.structuredContent).toEqual({
      folder: { id: expect.any(String), name: "技術" },
      created: true,
    });
    const techId = tech.structuredContent?.folder.id ?? "";
    // 前後と中の空白が違っても、整えた名前が同じなら、作らずに今あるものを返す
    expect((await create("  技術  ")).structuredContent).toEqual({
      folder: { id: techId, name: "技術" },
      created: false,
    });
    expect((await create("Web\u3000 開発")).structuredContent).toMatchObject({
      folder: { name: "Web 開発" },
      created: true,
    });
    expect((await create("Web 開発")).structuredContent).toMatchObject({ created: false });
    // 大文字と小文字は区別する
    const upper = await create("Tech");
    const lower = await create("tech");
    expect(upper.structuredContent?.created).toBe(true);
    expect(lower.structuredContent?.created).toBe(true);
    expect(lower.structuredContent?.folder.id).not.toBe(upper.structuredContent?.folder.id);
    // 空白だけの名前は作らない
    expect(await create(" \t ")).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "folder name is empty" }],
    });

    const folders = await client.callTool({ name: "list_folders", arguments: {} });
    expect(folders.structuredContent).toEqual({
      folders: [
        { id: upper.structuredContent?.folder.id, name: "Tech" },
        { id: expect.any(String), name: "Web 開発" },
        { id: lower.structuredContent?.folder.id, name: "tech" },
        { id: techId, name: "技術" },
      ],
    });

    const moved = await client.callTool({
      name: "move_feed",
      arguments: { feedId: feed.id, folderId: techId },
    });
    expect(moved.structuredContent).toEqual({
      feed: { id: feed.id, folderId: techId, folder: "技術" },
    });
    const workspaceList = await requestApp(platform, "/api/v1/workspaces", { token: user.token });
    const { items } = (await workspaceList.json()) as { items: Array<{ id: string }> };
    const [workspace] = items;
    if (!workspace) throw new Error("default workspace missing");

    const subscribe = async (url: string) => {
      const result = (await client.callTool({
        name: "subscribe",
        arguments: { url, folderId: techId },
      })) as Structured<{ feed: { id: string } }>;
      const feedId = result.structuredContent?.feed.id;
      if (!feedId) throw new Error("subscription missing");
      return getSubscription(platform.db, { userId: user.id, feedId });
    };
    const url = "https://new.example.com/feed.xml";
    const first = await subscribe(url);
    if (!first) throw new Error("subscription missing");
    expect(first).toMatchObject({ folderId: techId, folderName: "技術", workspaceId: null });

    const place = (workspaceId: string | null) =>
      requestApp(platform, `/api/v1/feeds/${first.feedId}`, {
        method: "PATCH",
        token: user.token,
        json: { subscriptionId: first.id, workspaceId },
      });
    expect((await place(workspace.id)).status).toBe(200);
    expect(await subscribe(url)).toMatchObject({ id: first.id, workspaceId: workspace.id });

    expect((await place(null)).status).toBe(200);
    expect(
      (
        await requestApp(platform, `/api/v1/workspaces/${workspace.id}`, {
          method: "DELETE",
          token: user.token,
        })
      ).status,
    ).toBe(204);
    expect(await subscribe("https://other.example.com/feed.xml")).toMatchObject({
      workspaceId: null,
    });
  });

  it("create_folder は、切り詰めた位置の直前が空白の名前でも、2 回目に同じフォルダを返す", async () => {
    const { platform, token } = await setup(["read", "write"]);
    const { client } = await connect(platform, token, era);
    const long = `${"a".repeat(199)} b`;

    const first = (await client.callTool({
      name: "create_folder",
      arguments: { name: long },
    })) as Structured<{ folder: { id: string; name: string }; created: boolean }>;
    expect(first.structuredContent).toMatchObject({
      folder: { name: "a".repeat(199) },
      created: true,
    });
    // 一覧に出た名前で作り直しても、同じフォルダ
    for (const name of [long, "a".repeat(199)]) {
      expect(
        (await client.callTool({ name: "create_folder", arguments: { name } })).structuredContent,
      ).toEqual({ folder: first.structuredContent?.folder, created: false });
    }
  });

  it("同じ名前の create_folder が同時に来ても、フォルダは 1 つで、どちらも同じ ID を返す", async () => {
    const { platform, token, user } = await setup(["read", "write"]);
    const { client } = await connect(platform, token, era);

    const results = (await Promise.all(
      [1, 2].map(() => client.callTool({ name: "create_folder", arguments: { name: "技術" } })),
    )) as Structured<{ folder: { id: string }; created: boolean }>[];

    const ids = results.map((r) => r.structuredContent?.folder.id);
    expect(ids[0]).toBeDefined();
    expect(ids[1]).toBe(ids[0]);
    expect(results.map((r) => r.structuredContent?.created).sort()).toEqual([false, true]);
    expect(await listFolders(platform.db, user.id)).toEqual([
      expect.objectContaining({ id: ids[0], name: "技術" }),
    ]);
  });

  it("create_folder がぶつかったフォルダが、読み直す前に消されたら、作り直して返す", async () => {
    const { platform, token, user } = await setup(["read", "write"]);
    const { folder: old } = await createFolder(platform.db, {
      userId: user.id,
      id: crypto.randomUUID(),
      name: "技術",
      now: new Date(),
    });
    // 名前でフォルダを読み直す文の直前に、別のリクエストがそのフォルダを消す
    const hooked = statementHook(
      (sql) => /^\s*select\b/i.test(sql) && /from "folders"/i.test(sql) && /"name" = \?/.test(sql),
      async () => {
        await deleteFolder(platform.db, { userId: user.id, id: old.id, now: new Date() });
      },
    );
    const { client } = await connect({ ...platform, db: hooked.db }, token, era);

    const created = (await client.callTool({
      name: "create_folder",
      arguments: { name: "技術" },
    })) as Structured<{ folder: { id: string; name: string }; created: boolean }>;

    expect(hooked.fired()).toBe(true);
    expect(created.structuredContent).toMatchObject({ folder: { name: "技術" }, created: true });
    expect(created.structuredContent?.folder.id).not.toBe(old.id);
    expect(await listFolders(platform.db, user.id)).toEqual([
      expect.objectContaining({ id: created.structuredContent?.folder.id, name: "技術" }),
    ]);
  });

  it("create_folder は、読み直すたびにぶつかったフォルダが消されると、3 回で諦めて誤りを返す", async () => {
    const { platform, token, user } = await setup(["read", "write"]);
    const make = () =>
      createFolder(platform.db, {
        userId: user.id,
        id: crypto.randomUUID(),
        name: "技術",
        now: new Date(),
      });
    await make();
    // 作る文の直前には別のリクエストが同じ名前のフォルダを作り（1 回目は前からある）、
    // 名前で読み直す文の直前にはそれを消す。これを毎回くり返す
    let calls = 0;
    const hooked = statementHook(
      (sql) =>
        /^\s*insert\s+into\s+"folders"/i.test(sql) ||
        (/^\s*select\b/i.test(sql) && /from "folders"/i.test(sql) && /"name" = \?/.test(sql)),
      async () => {
        if (calls % 2 === 1) {
          for (const folder of await listFolders(platform.db, user.id)) {
            await deleteFolder(platform.db, { userId: user.id, id: folder.id, now: new Date() });
          }
        } else if (calls > 0) {
          await make();
        }
        calls++;
        hooked.arm();
      },
    );
    const recording = recordingSyncUpdates();
    const { client } = await connect(
      { ...platform, db: hooked.db, syncUpdates: recording.syncUpdates },
      token,
      era,
    );

    expect(
      await client.callTool({ name: "create_folder", arguments: { name: "技術" } }),
    ).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "folder name is being changed concurrently; try again" }],
    });
    // 作る ／ 読み直すを 3 回ずつ
    expect(calls).toBe(6);
    expect(recording.notified).toEqual([]);
  });

  it("rename_folder で名前を変え、同じ名前・消したフォルダ・ほかの人のフォルダでは変えない", async () => {
    const { platform, token, user, feed } = await setup(["read", "write"]);
    const other = await createUser();
    const { client } = await connect(platform, token, era);
    const otherClient = (await connect(platform, await mcpToken(other.id, ["read", "write"]), era))
      .client;
    const tech = await createFolderTool(client, "技術");
    const news = await createFolderTool(client, "ニュース");
    const removed = await createFolderTool(client, "削除済み");
    await client.callTool({ name: "delete_folder", arguments: { folderId: removed.id } });
    const foreign = await createFolderTool(otherClient, "他ユーザー");
    await client.callTool({ name: "move_feed", arguments: { feedId: feed.id, folderId: tech.id } });
    const rename = (folderId: string, name: string) =>
      client.callTool({ name: "rename_folder", arguments: { folderId, name } });

    expect((await rename(tech.id, " プログラミング ")).structuredContent).toEqual({
      folder: { id: tech.id, name: "プログラミング" },
    });
    expect((await client.callTool({ name: "list_feeds" })).structuredContent).toMatchObject({
      feeds: [{ id: feed.id, folderId: tech.id, folder: "プログラミング" }],
    });

    expect(await rename(news.id, "プログラミング")).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "a folder with this name exists" }],
    });
    expect(await rename(news.id, "  ")).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "folder name is empty" }],
    });
    for (const missing of [removed.id, foreign.id, "unknown-folder"]) {
      expect(await rename(missing, "新しい名前")).toMatchObject({
        isError: true,
        content: [{ type: "text", text: "folder not found" }],
      });
    }
    expect((await client.callTool({ name: "list_folders" })).structuredContent).toEqual({
      folders: [
        { id: news.id, name: "ニュース" },
        { id: tech.id, name: "プログラミング" },
      ],
    });
    expect((await otherClient.callTool({ name: "list_folders" })).structuredContent).toEqual({
      folders: [{ id: foreign.id, name: "他ユーザー" }],
    });
  });

  it("delete_folder は購読をやめずに未分類に戻し、差分同期に届く。ないフォルダやほかの人のフォルダは消さない", async () => {
    const { platform, token, user, feed } = await setup(["read", "write"]);
    const second = await subscribeFeed(platform, { userId: user.id });
    const other = await createUser();
    const otherFeed = await subscribeFeed(platform, { userId: other.id });
    const { client } = await connect(platform, token, era);
    const otherClient = (await connect(platform, await mcpToken(other.id, ["read", "write"]), era))
      .client;
    const tech = await createFolderTool(client, "技術");
    const foreign = await createFolderTool(otherClient, "他ユーザー");
    for (const feedId of [feed.id, second.id]) {
      await client.callTool({ name: "move_feed", arguments: { feedId, folderId: tech.id } });
    }
    await otherClient.callTool({
      name: "move_feed",
      arguments: { feedId: otherFeed.id, folderId: foreign.id },
    });
    const initialSync = await requestApp(platform, "/api/v1/sync", { token: user.token });
    const { cursor } = (await initialSync.json()) as { cursor: string };
    const remove = (folderId: string) =>
      client.callTool({ name: "delete_folder", arguments: { folderId } });

    expect((await remove(tech.id)).structuredContent).toEqual({ deleted: true });

    expect((await client.callTool({ name: "list_folders" })).structuredContent).toEqual({
      folders: [],
    });
    const feeds = (await client.callTool({ name: "list_feeds" })) as Structured<{
      feeds: { id: string; folderId: string | null; folder: string | null }[];
    }>;
    expect(feeds.structuredContent?.feeds.map((f) => [f.id, f.folderId, f.folder]).sort()).toEqual(
      [
        [feed.id, null, null],
        [second.id, null, null],
      ].sort(),
    );
    const delta = await requestApp(platform, `/api/v1/sync?cursor=${encodeURIComponent(cursor)}`, {
      token: user.token,
    });
    const changes = (await delta.json()) as {
      folders: { id: string; deleted: boolean }[];
      feeds: { id: string; folderId: string | null; deleted: boolean }[];
    };
    expect(changes.folders).toEqual([expect.objectContaining({ id: tech.id, deleted: true })]);
    expect(changes.feeds.map((f) => [f.id, f.folderId, f.deleted]).sort()).toEqual(
      [
        [feed.id, null, false],
        [second.id, null, false],
      ].sort(),
    );

    // もう一度消しても、ほかの人のフォルダを指しても、消さない
    for (const folderId of [tech.id, foreign.id, "unknown-folder"]) {
      expect((await remove(folderId)).structuredContent).toEqual({ deleted: false });
    }
    expect(await listFolders(platform.db, other.id)).toEqual([
      expect.objectContaining({ id: foreign.id }),
    ]);
    expect(
      await getSubscription(platform.db, { userId: other.id, feedId: otherFeed.id }),
    ).toMatchObject({ folderId: foreign.id });
    // 消したフォルダは、移動先にも、名前を変える相手にも使えない
    expect(
      await client.callTool({
        name: "move_feed",
        arguments: { feedId: feed.id, folderId: tech.id },
      }),
    ).toMatchObject({ isError: true, content: [{ type: "text", text: "folder not found" }] });
    expect(
      await client.callTool({
        name: "rename_folder",
        arguments: { folderId: tech.id, name: "新しい名前" },
      }),
    ).toMatchObject({ isError: true, content: [{ type: "text", text: "folder not found" }] });
  });

  it("フォルダを変えるツールは、データを変えたときだけ開いている画面に知らせる", async () => {
    const { platform, token, user } = await setup(["read", "write"]);
    const recording = recordingSyncUpdates();
    platform.syncUpdates = recording.syncUpdates;
    const { client } = await connect(platform, token, era);
    const call = (name: string, args: Record<string, unknown>) =>
      client.callTool({ name, arguments: args }) as Promise<
        Structured<{ folder?: { id: string } }>
      >;

    const created = await call("create_folder", { name: "技術" });
    expect(recording.notified).toEqual([user.id]);
    const folderId = created.structuredContent?.folder?.id ?? "";

    // 今あるものを返しただけ、空の名前、ないフォルダ、名前がぶつかったときは知らせない
    await call("create_folder", { name: "技術" });
    await call("create_folder", { name: " " });
    await call("rename_folder", { folderId: "unknown-folder", name: "x" });
    await call("delete_folder", { folderId: "unknown-folder" });
    await call("create_folder", { name: "ニュース" });
    expect(recording.notified).toEqual([user.id, user.id]);
    await call("rename_folder", { folderId, name: "ニュース" });
    expect(recording.notified).toEqual([user.id, user.id]);

    await call("rename_folder", { folderId, name: "プログラミング" });
    await call("delete_folder", { folderId });
    expect(recording.notified).toEqual([user.id, user.id, user.id, user.id]);
  });

  it("取得してはいけない URL は購読せず、エラーの結果を返す", async () => {
    const { platform, token } = await setup(["read", "write"]);
    const { client } = await connect(platform, token, era);

    const res = (await client.callTool({
      name: "subscribe",
      arguments: { url: "http://127.0.0.1/feed" },
    })) as Structured<unknown>;

    expect(res.isError).toBe(true);
  });

  it("ほかの人の記事は、ID を知っていても読めず、変えられない", async () => {
    const victim = await setup();
    const { platform, token } = await setup(["read", "write"]);
    const { client } = await connect(platform, token, era);

    const article = (await client.callTool({
      name: "get_article",
      arguments: { id: victim.a1 },
    })) as Structured<unknown>;
    expect(article.isError).toBe(true);
    const read = (await client.callTool({
      name: "mark_read",
      arguments: { ids: [victim.a1] },
    })) as Structured<{ updated: number }>;
    expect(read.structuredContent).toEqual({ updated: 0 });
    expect(await state(victim.user.id, victim.a1)).toEqual({ read: 0, starred: 0 });
  });
});

describe("/mcp の認証", () => {
  const post = (platform: Platform, headers: Record<string, string>) =>
    createApp(platform).request(MCP_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

  it("トークンがない ／ REST API 用のトークンは 401", async () => {
    const { platform, user } = await setup();

    for (const headers of [{}, { authorization: `Bearer ${user.token}` }]) {
      const res = await post(platform, headers);
      expect(res.status, JSON.stringify(headers)).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain("Bearer");
    }
  });

  it("MCP 用のトークンは REST API では使えない", async () => {
    const { platform, token } = await setup(["read", "write"]);

    expect((await requestApp(platform, "/api/v1/feeds", { token })).status).toBe(401);
  });

  it("ほかのサイトのページからのリクエスト（Origin が違う）は 403", async () => {
    const { platform, token } = await setup();

    const res = await post(platform, {
      authorization: `Bearer ${token}`,
      origin: "https://evil.example.com",
    });

    expect(res.status).toBe(403);
  });
});

describe("MCP 用のトークンの発行", () => {
  it("用途と範囲を付けて発行でき、一覧に出る。write を付けると read も付く。reader に範囲は付けられない", async () => {
    const user = await createUser();
    const headers = await createSessionHeaders(user.id);
    const { platform } = createTestPlatform();
    const send = (json?: unknown) =>
      requestApp(platform, "/api/v1/tokens", {
        token: null,
        headers,
        ...(json === undefined ? {} : { method: "POST", json }),
      });

    const created = (await (
      await send({ name: "Claude Code", purpose: "mcp", scopes: ["write"] })
    ).json()) as {
      accessToken: { purpose: string; scopes: string[] };
    };
    expect(created.accessToken).toMatchObject({ purpose: "mcp", scopes: ["read", "write"] });

    const readOnly = (await (await send({ name: "reader-agent", purpose: "mcp" })).json()) as {
      accessToken: { scopes: string[] };
    };
    expect(readOnly.accessToken.scopes).toEqual(["read"]);

    expect((await send({ name: "Reeder", scopes: ["read"] })).status).toBe(400);
    const app = (await (await send({ name: "Reeder" })).json()) as {
      accessToken: { purpose: string; scopes: string[] };
    };
    expect(app.accessToken).toMatchObject({ purpose: "reader", scopes: [] });

    const list = (await (await send()).json()) as { items: { name: string; purpose: string }[] };
    expect(list.items.map((item) => [item.name, item.purpose])).toEqual(
      expect.arrayContaining([
        ["Claude Code", "mcp"],
        ["reader-agent", "mcp"],
        ["Reeder", "reader"],
      ]),
    );
  });
});
