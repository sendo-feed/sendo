import { env } from "cloudflare:workers";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import { insertArticles } from "../../src/db/articles";
import { createAccessToken } from "../../src/db/tokens";
import { runCleanUp } from "../../src/jobs/clean-up";
import { addToInbox, createTestPlatform, createUser, requestApp, subscribeFeed } from "../helpers";

describe("記事を開いた履歴", () => {
  it("再送を重ねず、本人が開いた記事を MCP から取得する。記事が消えても履歴が残る", async () => {
    let now = new Date("2026-11-18T02:00:00Z");
    const { platform } = createTestPlatform({ now: () => now });
    const user = await createUser();
    const other = await createUser();
    const feed = await subscribeFeed(platform, { userId: user.id });
    const titles = ["技術記事", "別の利用者の記事"];
    const rows = titles.map((title) => ({
      id: crypto.randomUUID(),
      guid: crypto.randomUUID(),
      feedId: feed.id,
      title,
      url: "https://example.com/read",
      summary: null,
      author: null,
      publishedAt: now,
      createdAt: now,
    }));
    await insertArticles(platform.db, rows);
    const own = rows[0];
    const foreign = rows[1];
    if (!own || !foreign) throw new Error("articles missing");
    await addToInbox(platform, [
      { articleId: own.id, userId: user.id, feedId: feed.id, publishedAt: now, receivedAt: now },
      {
        articleId: foreign.id,
        userId: other.id,
        feedId: feed.id,
        publishedAt: now,
        receivedAt: now,
      },
    ]);
    const opened = [
      { id: crypto.randomUUID(), articleId: own.id, occurredAt: "2026-11-18T00:00:00Z" },
      { id: crypto.randomUUID(), articleId: own.id, occurredAt: "2026-11-18T01:00:00Z" },
      { id: crypto.randomUUID(), articleId: foreign.id, occurredAt: "2026-11-18T01:30:00Z" },
      { id: crypto.randomUUID(), articleId: own.id, occurredAt: "2026-01-01T00:00:00Z" },
      { id: crypto.randomUUID(), articleId: own.id, occurredAt: "2026-11-18T03:00:00Z" },
    ];
    const send = () =>
      requestApp(platform, "/api/v1/activity", {
        token: user.token,
        method: "POST",
        json: { events: opened },
      });
    expect(await (await send()).json()).toEqual({ recorded: 2 });
    expect(await (await send()).json()).toEqual({ recorded: 0 });

    await env.DB.prepare("DELETE FROM articles WHERE id = ?").bind(own.id).run();

    async function connect(userId: string) {
      const { token } = await createAccessToken(platform.db, {
        userId,
        name: "activity test",
        now,
        purpose: "mcp",
        scopes: ["read"],
      });
      const client = new Client({ name: "activity test", version: "0.0.0" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL("https://sendo.example.com/mcp"), {
          fetch: async (input, init) =>
            createApp(platform).request(input instanceof Request ? input : String(input), init),
          requestInit: { headers: { authorization: `Bearer ${token}` } },
        }),
      );
      return client;
    }
    const client = await connect(user.id);
    const query = {
      type: "article_opened",
      source: "reader",
      since: "2026-11-18T09:00:00+09:00",
      until: "2026-11-18T11:00:00+09:00",
      limit: 1,
    };
    const first = await client.callTool({ name: "list_activity", arguments: query });
    expect(first.structuredContent).toMatchObject({
      events: [
        {
          id: opened[1]?.id,
          occurredAt: "2026-11-18T01:00:00.000Z",
          type: "article_opened",
          source: "reader",
          article: { id: own.id, title: own.title, url: own.url },
        },
      ],
      nextCursor: expect.any(String),
    });
    const { nextCursor } = first.structuredContent as { nextCursor: string };
    const second = await client.callTool({
      name: "list_activity",
      arguments: { ...query, cursor: nextCursor },
    });
    expect(second.structuredContent).toMatchObject({
      events: [{ id: opened[0]?.id }],
      nextCursor: null,
    });
    const otherClient = await connect(other.id);
    const otherHistory = await otherClient.callTool({ name: "list_activity", arguments: {} });
    expect(otherHistory.structuredContent).toEqual({ events: [], nextCursor: null });

    now = new Date("2027-02-17T02:00:00Z");
    const expired = await client.callTool({ name: "list_activity", arguments: {} });
    expect(expired.structuredContent).toEqual({ events: [], nextCursor: null });
    expect(await runCleanUp(platform)).toMatchObject({ activity: 2 });
  });
});
