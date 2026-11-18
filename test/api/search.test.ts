import { env } from "cloudflare:workers";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import { insertArticles } from "../../src/db/articles";
import { setArticlesState } from "../../src/db/inbox";
import { createAccessToken } from "../../src/db/tokens";
import { indexArticleSearch } from "../../src/jobs/article-search";
import { addToInbox, createTestPlatform, createUser, subscribeFeed } from "../helpers";

describe("MCP の記事検索", () => {
  it("索引と短い語で検索し、本人の既読日時とページ送りで絞る", async () => {
    const { platform } = createTestPlatform();
    const user = await createUser();
    const other = await createUser();
    const feed = await subscribeFeed(platform, { userId: user.id });
    const published = new Date("2026-09-01T00:00:00Z");
    const titles = ["日本語の記事", ".NET 記事", ".NET 未読", ".NET 非公開"];
    const records = titles.map((title) => ({
      id: crypto.randomUUID(),
      guid: crypto.randomUUID(),
      feedId: feed.id,
      title,
      url: "https://example.com/article",
      summary: null,
      author: null,
      publishedAt: published,
      createdAt: published,
    }));
    await insertArticles(platform.db, records);
    await addToInbox(
      platform,
      records.map((a, i) => ({
        articleId: a.id,
        userId: i === 3 ? other.id : user.id,
        feedId: feed.id,
        publishedAt: published,
        receivedAt: published,
      })),
    );
    const [bodyMatch, titleMatch] = records;
    if (!bodyMatch || !titleMatch) throw new Error("articles missing");
    const key = `feed/${bodyMatch.id}`;
    await platform.content.put(key, "<p>ここの本文だけに <b>.NET</b> と短い語「技術」がある</p>");
    await env.DB.prepare("UPDATE articles SET content_key = ? WHERE id = ?")
      .bind(key, bodyMatch.id)
      .run();
    await setArticlesState(platform.db, {
      userId: user.id,
      target: { articleIds: [titleMatch.id] },
      read: true,
      starred: true,
      now: new Date("2026-11-02T00:00:00Z"),
    });
    await setArticlesState(platform.db, {
      userId: user.id,
      target: { articleIds: [bodyMatch.id] },
      read: true,
      starred: true,
      now: new Date("2026-11-03T00:00:00Z"),
    });
    const { token } = await createAccessToken(platform.db, {
      userId: user.id,
      name: "search test",
      now: new Date(),
      purpose: "mcp",
      scopes: ["read"],
    });
    const client = new Client({ name: "search test", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL("https://sendo.example.com/mcp"), {
        fetch: async (input, init) =>
          createApp(platform).request(input instanceof Request ? input : String(input), init),
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );
    const search = (args: Record<string, unknown>) =>
      client.callTool({ name: "search_articles", arguments: args });
    const fallback = await search({ keyword: "日本語" });
    expect(fallback.structuredContent).toMatchObject({
      articles: [{ id: bodyMatch.id, snippet: expect.stringContaining("日本語") }],
    });

    await env.DB.exec("UPDATE article_search_state SET day = unixepoch() / 86400, writes = 1499");
    await Promise.all([indexArticleSearch(platform), indexArticleSearch(platform)]);
    const counted = await env.DB.prepare("SELECT writes FROM article_search_state").first();
    expect(counted).toEqual({ writes: 1500 });
    expect(
      await env.DB.prepare("SELECT count(*) AS indexed FROM article_search_documents").first(),
    ).toEqual({ indexed: 1 });

    await env.DB.exec("UPDATE article_search_state SET writes = 0");
    await env.DB.exec("UPDATE article_search_pending SET retry_at = 0");
    await indexArticleSearch(platform);

    const query = {
      keyword: ".NET",
      state: "read",
      starred: true,
      dateBy: "readAt",
      limit: 1,
      since: "2026-11-01T00:00:00Z",
      until: "2026-12-01T00:00:00Z",
    };
    const first = await search(query);
    expect(first.structuredContent).toMatchObject({
      articles: [{ id: bodyMatch.id, snippet: expect.stringContaining(".NET") }],
      nextCursor: expect.any(String),
    });
    const { nextCursor } = first.structuredContent as { nextCursor: string };
    const second = await search({ ...query, cursor: nextCursor });
    expect(second.structuredContent).toMatchObject({
      articles: [{ id: titleMatch.id }],
      nextCursor: null,
    });
    expect(await search({ ...query, keyword: "技術", cursor: nextCursor })).toMatchObject({
      isError: true,
    });
    expect((await search({ keyword: "技術" })).structuredContent).toMatchObject({
      articles: [{ id: bodyMatch.id, snippet: expect.stringContaining("技術") }],
    });
    expect((await search({ keyword: '" OR *' })).structuredContent).toEqual({
      articles: [],
      nextCursor: null,
    });
    await env.DB.prepare("DELETE FROM articles WHERE id = ?").bind(bodyMatch.id).run();
    expect((await search({ keyword: "技術" })).structuredContent).toEqual({
      articles: [],
      nextCursor: null,
    });
  });
});
