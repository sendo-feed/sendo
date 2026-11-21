import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { connectDiscord, disconnectDiscord, insertDiscordArticles } from "../../src/db/discord";
import { findFeedByUrl, getFeed } from "../../src/db/feeds";
import { articles, contentNotes, feeds } from "../../src/db/schema";
import { createSession } from "../../src/db/sessions";
import { readStorageUsage } from "../../src/db/storage";
import { subscribeMany } from "../../src/db/subscriptions";
import { runFetchFeed } from "../../src/jobs/fetch-feed";
import type { Platform } from "../../src/platform";
import { createTestPlatform, createUser, fakeFetch, requestApp, statementHook } from "../helpers";

const BASE = "/api/v1/integrations/discord";
const ORIGIN = "https://reader.example.com";
const DISCORD_USER = "102";
const SECOND_DISCORD_USER = "103";
const CONFIG = {
  clientId: "101",
  clientSecret: "test-discord-secret",
  botToken: "test-bot-token",
  redirectUri: `${ORIGIN + BASE}/callback`,
};
const CHANNEL = "https://discord.com/channels/201/301";
const READ = String((1 << 10) | (1 << 16));
const FIXED_NOW = new Date("2026-11-19T00:00:00Z");
const DISCORD_EPOCH_MS = 1420070400000;
const messageIdAt = (ms: number, n = 1n) => ((BigInt(ms - DISCORD_EPOCH_MS) << 22n) + n).toString();
const MESSAGE_ID = messageIdAt(FIXED_NOW.getTime());
const HOUR = 60 * 60 * 1000;

function discordFetch() {
  let canRead = true;
  let beforeMessages: (() => Promise<void>) | undefined;
  let messageStatus = 200;
  let errorCode: number | undefined;
  let messageIds = [MESSAGE_ID];
  let systemIds: string[] = [];
  let bodies = new Map<string, Record<string, unknown>>();
  const result = fakeFetch(async (url, init) => {
    expect(url.origin).toBe("https://discord.com");
    expect(init?.redirect).toBe("manual");
    const path = url.pathname;
    const auth = new Headers(init?.headers).get("authorization");
    if (path === "/api/v10/oauth2/token") {
      expect(init?.method).toBe("POST");
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("client_secret")).toBe(CONFIG.clientSecret);
      expect(body.get("redirect_uri")).toBe(CONFIG.redirectUri);
      expect(body.get("code")).toBe("test-code");
      return Response.json({ access_token: "fake-access-token" });
    }
    if (path === "/api/v10/users/@me") {
      expect(auth).toBe("Bearer fake-access-token");
      return Response.json({ id: DISCORD_USER });
    }
    expect(auth).toBe(`Bot ${CONFIG.botToken}`);
    if (path === "/api/v10/guilds/201") {
      return Response.json({ owner_id: "104", roles: [{ id: "201", permissions: READ }] });
    }
    if (path === "/api/v10/channels/301") {
      return Response.json({
        id: "301",
        guild_id: "201",
        type: 5,
        name: "releases",
        permission_overwrites: canRead
          ? []
          : [{ id: DISCORD_USER, type: 1, deny: READ, allow: "0" }],
      });
    }
    if (path.startsWith("/api/v10/guilds/201/members/")) {
      return Response.json({ roles: [] });
    }
    if (path === "/api/v10/channels/301/messages") {
      if (beforeMessages) await beforeMessages();
      if (messageStatus !== 200) {
        return Response.json(
          { code: errorCode },
          { status: messageStatus, headers: { "retry-after": "3600.5" } },
        );
      }
      // Discord と同じく、after があればその直後から、なければ新しいほうから limit 件を返す。
      const after = url.searchParams.get("after");
      const limit = Number(url.searchParams.get("limit"));
      const ascending = [...messageIds].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
      const page =
        after === null
          ? ascending.slice(-limit)
          : ascending.filter((id) => BigInt(id) > BigInt(after)).slice(0, limit);
      return Response.json(
        page.reverse().map((id) => ({
          id,
          channel_id: "301",
          type: systemIds.includes(id) ? 7 : 0,
          content: "Version 1.0\n<script>literal text</script>",
          author: { username: "alice" },
          timestamp: new Date(Number(BigInt(id) >> 22n) + DISCORD_EPOCH_MS).toISOString(),
          attachments: [],
          embeds: [],
          ...bodies.get(id),
        })),
      );
    }
    return new Response(null, { status: 404 });
  });
  return {
    ...result,
    deny: () => {
      canRead = false;
    },
    setMessageIds: (ids: string[]) => {
      messageIds = ids;
    },
    setSystemIds: (ids: string[]) => {
      systemIds = ids;
    },
    /** 投稿ごとに、テキストや埋め込みを差し替える */
    setMessages: (messages: Record<string, Record<string, unknown>>) => {
      bodies = new Map(Object.entries(messages));
      messageIds = Object.keys(messages);
    },
    setMessageStatus: (status: number, code?: number) => {
      messageStatus = status;
      errorCode = code;
    },
    beforeMessages: (fn: () => Promise<void>) => {
      beforeMessages = fn;
    },
  };
}

async function browser(platform: Platform, userId: string) {
  const { token } = await createSession(platform.db, { userId, now: platform.now() });
  const session = `__Host-sendo_session=${token}`;
  return (path: string, init: RequestInit & { json?: unknown; cookie?: string } = {}) => {
    const { cookie, ...rest } = init;
    const headers = new Headers(rest.headers);
    headers.set("cookie", cookie ? `${session}; ${cookie}` : session);
    if (!headers.has("sec-fetch-site")) headers.set("sec-fetch-site", "same-origin");
    return requestApp(platform, ORIGIN + path, { ...rest, token: null, headers });
  };
}

async function setup() {
  const remote = discordFetch();
  return {
    remote,
    ...createTestPlatform({ discord: CONFIG, fetch: remote.fetch, now: () => FIXED_NOW }),
  };
}

async function subscribe(request: Awaited<ReturnType<typeof browser>>) {
  const result = await request(`${BASE}/subscriptions`, { method: "POST", json: { url: CHANNEL } });
  expect(result.status).toBe(201);
  return ((await result.json()) as { feedId: string }).feedId;
}

describe("Discord の購読", () => {
  it("同じブラウザとセッションで許可した Discord アカウントを接続する", async () => {
    const { platform, remote } = await setup();
    const user = await createUser();
    const request = await browser(platform, user.id);
    expect((await requestApp(platform, BASE, { token: user.token })).status).toBe(403);
    expect(
      (
        await request(`${BASE}/connect`, {
          method: "POST",
          json: {},
          headers: { "sec-fetch-site": "cross-site" },
        })
      ).status,
    ).toBe(403);
    const start = await request(`${BASE}/connect`, {
      method: "POST",
      json: { returnTo: "/settings?tab=integrations#discord" },
    });
    expect(start.status).toBe(200);
    const { authorizationUrl } = (await start.json()) as { authorizationUrl: string };
    const url = new URL(authorizationUrl);
    expect(url.searchParams.get("scope")).toBe("identify");
    expect(url.searchParams.get("redirect_uri")).toBe(CONFIG.redirectUri);
    const cookie = start.headers
      .getSetCookie()
      .find((header) => header.startsWith("__Host-sendo_discord="))
      ?.split(";")[0];
    expect(cookie).toBeDefined();
    const path = `${BASE}/callback?code=test-code&state=${url.searchParams.get("state")}`;
    const otherSession = await browser(platform, user.id);
    const rejected = await otherSession(path, cookie ? { cookie } : {});
    expect(rejected.headers.get("location")).toBe("/?discord=invalid_state");
    expect(remote.calls).toEqual([]);

    const accepted = await request(path, cookie ? { cookie } : {});
    expect(accepted.headers.get("location")).toBe(
      "/settings?tab=integrations&discord=connected#discord",
    );
    expect(await (await request(BASE)).json()).toMatchObject({
      available: true,
      connected: true,
      subscriptions: [],
    });
  });

  it("同じチャンネルでもユーザーごとに購読し、取り込んだ投稿を他の人に渡さない", async () => {
    const { platform, enqueued, remote } = await setup();
    platform.pageContent = {
      async extract() {
        throw new Error("Discord の投稿では実行しない");
      },
    };
    const owner = await createUser();
    const other = await createUser();
    await connectDiscord(platform.db, owner.id, DISCORD_USER);
    await connectDiscord(platform.db, other.id, SECOND_DISCORD_USER);
    const request = await browser(platform, owner.id);
    const feedId = await subscribe(request);
    const repeated = await request(`${BASE}/subscriptions`, {
      method: "POST",
      json: { url: CHANNEL },
    });
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toMatchObject({ feedId });
    expect(await findFeedByUrl(platform.db, CHANNEL)).toBeUndefined();
    await expect(
      subscribeMany(platform.db, {
        userId: other.id,
        rows: [{ feedId, folderId: null }],
        now: FIXED_NOW,
      }),
    ).rejects.toThrow();
    const otherFeed = await subscribe(await browser(platform, other.id));
    expect(otherFeed).not.toBe(feedId);
    expect(enqueued).toEqual([
      { type: "fetch-feed", feedId },
      { type: "fetch-feed", feedId: otherFeed },
    ]);

    expect(await runFetchFeed(platform, feedId)).toEqual({ status: "fetched", inserted: 1 });
    expect(await runFetchFeed(platform, feedId)).toEqual({ status: "not-modified" });
    expect((await getFeed(platform.db, feedId))?.lastSuccessfulFetchAt).toEqual(FIXED_NOW);
    const owners = await (
      await requestApp(platform, "/api/v1/articles", { token: owner.token })
    ).json();
    const first = (owners as { items: { id: string }[] }).items[0];
    expect(first).toBeDefined();
    const fetchCount = remote.calls.length;
    const content = await requestApp(
      platform,
      `/api/v1/articles/${first?.id}/content?source=page`,
      {
        token: owner.token,
      },
    );
    expect(content.status).toBe(404);
    expect(remote.calls).toHaveLength(fetchCount);
    expect(owners).toMatchObject({
      items: [
        {
          feedId,
          url: `${CHANNEL}/${MESSAGE_ID}`,
          title: "Version 1.0",
          summary: "Version 1.0\n<script>literal text</script>",
        },
      ],
    });
    expect(
      await (await requestApp(platform, "/api/v1/articles", { token: other.token })).json(),
    ).toMatchObject({ items: [] });
  });

  it("購読した直後の取得で、直近の投稿を 20 件まで取り込み、投稿のペースで次の取得を決める", async () => {
    const { platform, remote } = await setup();
    const user = await createUser();
    await connectDiscord(platform.db, user.id, DISCORD_USER);
    const feedId = await subscribe(await browser(platform, user.id));
    // 1 時間おきに 25 件。新しいほうから 20 件だけを取り込む。1 件はシステムメッセージ。
    const now = FIXED_NOW.getTime();
    const ids = Array.from({ length: 25 }, (_, i) => messageIdAt(now - (25 - i) * HOUR));
    const system = ids[24] as string;
    remote.setMessageIds(ids);
    remote.setSystemIds([system]);
    const guids = async () =>
      (
        await platform.db
          .select({ guid: articles.guid })
          .from(articles)
          .where(eq(articles.feedId, feedId))
          .orderBy(articles.publishedAt)
      ).map(({ guid }) => guid);
    const inbox = async () =>
      (
        (await (
          await requestApp(platform, "/api/v1/articles?limit=50", { token: user.token })
        ).json()) as { items: unknown[] }
      ).items.length;

    expect(await runFetchFeed(platform, feedId)).toEqual({ status: "fetched", inserted: 19 });
    expect(await guids()).toEqual(ids.slice(5, 24));
    expect(await inbox()).toBe(19);
    // Discord の投稿の時刻は正確なので、公開時刻が分かるものとして入れる（docs/decisions/jobs.md の 11）
    expect(
      (
        await platform.db
          .select({ known: articles.publishedTimeKnown })
          .from(articles)
          .where(eq(articles.feedId, feedId))
      ).every(({ known }) => known),
    ).toBe(true);
    const fetched = await getFeed(platform.db, feedId);
    expect(fetched?.discordCursor).toBe(system);
    // 20 時間に 19 件なので、間隔は下限（30 分）になる。記事がないときの 1 日にはならない。
    expect(fetched?.nextFetchAt.getTime()).toBe(now + platform.fetchConfig.intervalMs);

    // 記録の前に落ちてやり直しても、同じ投稿を重ねて入れない。
    await platform.db
      .update(feeds)
      .set({ discordCursor: "0", lastFetchedAt: null })
      .where(eq(feeds.id, feedId));
    expect(await runFetchFeed(platform, feedId)).toEqual({ status: "fetched", inserted: 0 });
    expect(await guids()).toEqual(ids.slice(5, 24));
    expect(await inbox()).toBe(19);

    // 2 回目からは、取得位置より後の投稿だけを取る。
    await platform.db.update(feeds).set({ lastFetchedAt: null }).where(eq(feeds.id, feedId));
    remote.setMessageIds([...ids, MESSAGE_ID]);
    expect(await runFetchFeed(platform, feedId)).toEqual({ status: "fetched", inserted: 1 });
    expect(await guids()).toEqual([...ids.slice(5, 24), MESSAGE_ID]);
    expect(remote.calls.filter((call) => call.url.includes("/messages")).at(-1)?.url).toContain(
      `after=${system}`,
    );
  });

  it("1 回目の取得が遅れて、購読より後の投稿が 20 件を超えても、取りこぼさない", async () => {
    const { platform, remote } = await setup();
    const user = await createUser();
    await connectDiscord(platform.db, user.id, DISCORD_USER);
    const feedId = await subscribe(await browser(platform, user.id));
    const now = FIXED_NOW.getTime();
    const ids = Array.from({ length: 25 }, (_, i) => messageIdAt(now + i));
    remote.setMessageIds(ids);
    const count = async () =>
      (await platform.db.select().from(articles).where(eq(articles.feedId, feedId))).length;

    expect(await runFetchFeed(platform, feedId)).toEqual({ status: "fetched", inserted: 20 });
    const fetched = await getFeed(platform.db, feedId);
    // 取った 20 件より前にも購読より後の投稿があるので、取得位置は購読の時刻に置き、すぐ続きを取る。
    expect(BigInt(fetched?.discordCursor ?? "0")).toBeLessThan(BigInt(ids[0] as string));
    expect(fetched?.discordCursor).not.toBe("0");
    expect(fetched?.nextFetchAt.getTime()).toBe(now + platform.fetchConfig.intervalMs);

    await platform.db.update(feeds).set({ lastFetchedAt: null }).where(eq(feeds.id, feedId));
    expect(await runFetchFeed(platform, feedId)).toEqual({ status: "fetched", inserted: 5 });
    expect(await count()).toBe(25);
    expect((await getFeed(platform.db, feedId))?.discordCursor).toBe(ids[24]);
  });

  it("毎日決まった時刻に投稿されるチャンネルは、その時刻に取りにいく（docs/decisions/jobs.md の 11）", async () => {
    const { platform, remote } = await setup();
    const user = await createUser();
    await connectDiscord(platform.db, user.id, DISCORD_USER);
    const feedId = await subscribe(await browser(platform, user.id));
    // 40 日前に購読し、1〜28 日前の 07:00 UTC に毎日 1 件ずつ投稿があった
    const day = 24 * HOUR;
    await platform.db
      .update(feeds)
      .set({ createdAt: new Date(FIXED_NOW.getTime() - 40 * day) })
      .where(eq(feeds.id, feedId));
    const connectionId = (await getFeed(platform.db, feedId))?.discordConnectionId ?? "";
    const posts = Array.from(
      { length: 28 },
      (_, i) => FIXED_NOW.getTime() - (i + 1) * day + 7 * HOUR,
    );
    expect(
      await insertDiscordArticles(
        platform.db,
        feedId,
        connectionId,
        posts.map((publishedAt) => ({
          id: crypto.randomUUID(),
          guid: messageIdAt(publishedAt),
          url: `${CHANNEL}/${messageIdAt(publishedAt)}`,
          title: "daily",
          summary: "daily",
          author: "bot",
          publishedAt,
          contentKey: null,
        })),
      ),
    ).toBe(28);
    remote.setMessageIds([]);

    expect(await runFetchFeed(platform, feedId)).toEqual({ status: "not-modified" });
    expect((await getFeed(platform.db, feedId))?.nextFetchAt.toISOString()).toBe(
      "2026-11-19T07:00:00.000Z",
    );
  });

  it("購読した直後の取得で投稿がなければ、そのあとの投稿から取り込む", async () => {
    const { platform, remote } = await setup();
    const user = await createUser();
    await connectDiscord(platform.db, user.id, DISCORD_USER);
    const feedId = await subscribe(await browser(platform, user.id));
    remote.setMessageIds([]);
    expect(await runFetchFeed(platform, feedId)).toEqual({ status: "not-modified" });
    expect((await getFeed(platform.db, feedId))?.discordCursor).not.toBe("0");

    await platform.db.update(feeds).set({ lastFetchedAt: null }).where(eq(feeds.id, feedId));
    remote.setMessageIds([MESSAGE_ID]);
    expect(await runFetchFeed(platform, feedId)).toEqual({ status: "fetched", inserted: 1 });
  });

  it("閲覧権限の喪失で、投稿と購読の削除を同期に届ける", async () => {
    const { platform, remote } = await setup();
    const user = await createUser();
    await connectDiscord(platform.db, user.id, DISCORD_USER);
    const request = await browser(platform, user.id);
    const feedId = await subscribe(request);
    await runFetchFeed(platform, feedId);
    const sync = async (cursor?: string) => {
      const url = `/api/v1/sync${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`;
      const response = await requestApp(platform, url, { token: user.token });
      expect(response.status).toBe(200);
      return (await response.json()) as {
        cursor: string;
        feeds: { id: string; deleted: boolean }[];
        articles: { id: string; deleted: boolean }[];
      };
    };
    const initial = await sync();
    expect(initial.feeds).toMatchObject([{ id: feedId, deleted: false }]);
    const firstArticle = initial.articles[0];
    expect(firstArticle).toBeDefined();
    const starred = await requestApp(platform, `/api/v1/articles/${firstArticle?.id}`, {
      method: "PATCH",
      json: { starred: true },
      token: user.token,
    });
    expect(starred.ok).toBe(true);

    remote.deny();
    expect(await runFetchFeed(platform, feedId)).toMatchObject({ status: "missing" });
    const changed = await sync(initial.cursor);
    expect(changed.feeds).toMatchObject([{ id: feedId, deleted: true }]);
    expect(changed.articles).toMatchObject([{ id: firstArticle?.id, deleted: true }]);
    expect(
      (await request(`${BASE}/subscriptions`, { method: "POST", json: { url: CHANNEL } })).status,
    ).toBe(404);
  });

  it.each([
    { count: 0, ids: [] },
    { count: 1, ids: [MESSAGE_ID] },
  ])("連携解除と並行した取得では投稿 $count 件の結果を残さない", async ({ ids }) => {
    const { platform, remote } = await setup();
    const user = await createUser();
    await connectDiscord(platform.db, user.id, DISCORD_USER);
    const feedId = await subscribe(await browser(platform, user.id));
    remote.setMessageIds(ids);
    remote.beforeMessages(() => disconnectDiscord(platform.db, user.id));
    await runFetchFeed(platform, feedId);
    expect(await platform.db.select().from(articles).where(eq(articles.feedId, feedId))).toEqual(
      [],
    );
    expect(await getFeed(platform.db, feedId)).toMatchObject({
      discordConnectionId: null,
      lastSuccessfulFetchAt: null,
    });
    expect(await (await (await browser(platform, user.id))(BASE)).json()).toMatchObject({
      connected: false,
      subscriptions: [],
    });
  });

  it("容量で一部しか保存できなかった投稿を、空きを作ったあとに取り直す", async () => {
    const { platform, remote, enqueued } = await setup();
    const user = await createUser();
    await connectDiscord(platform.db, user.id, DISCORD_USER);
    const feedId = await subscribe(await browser(platform, user.id));
    const startCursor = (await getFeed(platform.db, feedId))?.discordCursor;
    const newerId = (BigInt(MESSAGE_ID) + 1n).toString();
    remote.setMessageIds([newerId, MESSAGE_ID]);

    const baseline = (await readStorageUsage(platform.db)).bytes;
    platform.retentionConfig = { maxBytes: baseline + 4200 };
    expect(await runFetchFeed(platform, feedId)).toEqual({ status: "storage-full" });
    const stored = () =>
      platform.db
        .select({ guid: articles.guid })
        .from(articles)
        .where(eq(articles.feedId, feedId))
        .orderBy(articles.guid);
    expect(await stored()).toEqual([{ guid: newerId }]);
    expect((await getFeed(platform.db, feedId))?.discordCursor).toBe(startCursor);
    expect(enqueued).toContainEqual({ type: "clean-up" });

    platform.retentionConfig = { maxBytes: baseline + 32 * 1024 };
    expect(await runFetchFeed(platform, feedId)).toEqual({ status: "fetched", inserted: 1 });
    expect(await stored()).toEqual([{ guid: MESSAGE_ID }, { guid: newerId }]);
    expect((await getFeed(platform.db, feedId))?.discordCursor).toBe(newerId);
  });

  it("レート制限は解除と区別し、Retry-After を守る", async () => {
    const { platform, remote } = await setup();
    const user = await createUser();
    await connectDiscord(platform.db, user.id, DISCORD_USER);
    const request = await browser(platform, user.id);
    const feedId = await subscribe(request);
    remote.setMessageStatus(429);
    expect(await runFetchFeed(platform, feedId)).toMatchObject({ status: "failed" });
    const feed = await platform.db.query.feeds.findFirst({
      where: (f, { eq }) => eq(f.id, feedId),
    });
    expect(feed?.nextFetchAt.getTime()).toBeGreaterThanOrEqual(FIXED_NOW.getTime() + 3600500);
    expect(feed).toMatchObject({
      lastErrorCode: "rate_limited",
      errorCount: 0,
      failureStartedAt: null,
    });
    expect(await (await request(BASE)).json()).toMatchObject({ subscriptions: [{ feedId }] });

    remote.setMessageStatus(403, 40333);
    expect(await runFetchFeed(platform, feedId)).toMatchObject({ status: "failed" });
    expect(await (await request(BASE)).json()).toMatchObject({ subscriptions: [{ feedId }] });

    remote.setMessageStatus(403, 50001);
    expect(await runFetchFeed(platform, feedId)).toMatchObject({ status: "missing" });
    expect(await (await request(BASE)).json()).toMatchObject({ subscriptions: [] });
  });
});

describe("Discord の投稿の本文（docs/decisions/discord.md の 6）", () => {
  const id = (n: number) => messageIdAt(FIXED_NOW.getTime() - 60_000 * (10 - n));
  const LINK = 'rel="noopener noreferrer nofollow"';

  async function subscribed(overrides: Partial<Platform> = {}) {
    const remote = discordFetch();
    const { platform } = createTestPlatform({
      discord: CONFIG,
      fetch: remote.fetch,
      now: () => FIXED_NOW,
      ...overrides,
    });
    const user = await createUser();
    await connectDiscord(platform.db, user.id, DISCORD_USER);
    const feedId = await subscribe(await browser(platform, user.id));
    const article = async (guid: string) => {
      const list = (await (
        await requestApp(platform, "/api/v1/articles?limit=50", { token: user.token })
      ).json()) as {
        items: {
          id: string;
          url: string;
          title: string;
          summary: string | null;
          hasContent: boolean;
        }[];
      };
      const found = list.items.find((item) => item.url === `${CHANNEL}/${guid}`);
      if (!found) throw new Error(`no article: ${guid}`);
      const res = await requestApp(platform, `/api/v1/articles/${found.id}/content`, {
        token: user.token,
      });
      const html = res.ok ? ((await res.json()) as { html: string }).html : null;
      return { ...found, html };
    };
    return { platform, remote, user, feedId, article };
  }

  it("テキストだけの投稿も本文を置き、改行を保ち、URL をリンクにする。書式と HTML は文字のまま", async () => {
    const t = await subscribed();
    const text = [
      "sendo の自動更新: reader を 25c1fb8 → 6654792 に上げた (https://github.com/sendo-feed/sendo-reader/compare/25c1fb8...6654792)",
      "<@123> <script>alert(1)</script> **太字**",
      "",
      "続き <https://example.com/a_(b)>",
    ].join("\n");
    t.remote.setMessages({ [id(1)]: { content: text } });
    expect(await runFetchFeed(t.platform, t.feedId)).toEqual({ status: "fetched", inserted: 1 });

    const article = await t.article(id(1));
    expect(article).toMatchObject({
      title:
        "sendo の自動更新: reader を 25c1fb8 → 6654792 に上げた (https://github.com/sendo-feed/sendo-reader/compare/25c1fb8...6654792)",
      summary: text,
      hasContent: true,
    });
    const compare = "https://github.com/sendo-feed/sendo-reader/compare/25c1fb8...6654792";
    expect(article.html).toBe(
      `<p>sendo の自動更新: reader を 25c1fb8 → 6654792 に上げた (<a href="${compare}" ${LINK}>${compare}</a>)<br>` +
        "&lt;@123&gt; &lt;script&gt;alert(1)&lt;/script&gt; **太字**</p>" +
        `<p>続き &lt;<a href="https://example.com/a_(b)" ${LINK}>https://example.com/a_(b)</a>&gt;</p>`,
    );
  });

  it("埋め込みだけの投稿は、埋め込みの文字を本文にし、タイトルと説明をタイトルと要約にする", async () => {
    const t = await subscribed();
    t.remote.setMessages({
      [id(1)]: {
        content: "",
        embeds: [
          {
            type: "rich",
            author: { name: "GCP Billing", icon_url: "https://cdn.example/author.png" },
            title: "今月の費用",
            url: "https://console.cloud.google.com/billing",
            description: "予算の 80% に達しました\n詳細は https://example.com/report",
            fields: [
              { name: "今月", value: "¥8,000", inline: true },
              { name: "予算", value: "¥10,000" },
            ],
            footer: { text: "Cloud Billing", icon_url: "https://cdn.example/footer.png" },
            image: { url: "https://cdn.example/image.png" },
            thumbnail: { url: "https://cdn.example/thumb.png" },
            video: { url: "https://cdn.example/video.mp4" },
          },
        ],
      },
    });
    await runFetchFeed(t.platform, t.feedId);

    const article = await t.article(id(1));
    expect(article).toMatchObject({
      title: "今月の費用",
      summary: "予算の 80% に達しました\n詳細は https://example.com/report",
      hasContent: true,
    });
    expect(article.html).toBe(
      "<blockquote><p><small>GCP Billing</small></p>" +
        `<p><strong><a href="https://console.cloud.google.com/billing" ${LINK}>今月の費用</a></strong></p>` +
        `<p>予算の 80% に達しました<br>詳細は <a href="https://example.com/report" ${LINK}>https://example.com/report</a></p>` +
        "<dl><dt>今月</dt><dd>¥8,000</dd><dt>予算</dt><dd>¥10,000</dd></dl>" +
        "<p><small>Cloud Billing</small></p></blockquote>",
    );
    expect(article.html).not.toContain("cdn.example");
  });

  it("タイトルと要約を、タイトルか説明のある最初の埋め込みから採る", async () => {
    const t = await subscribed();
    t.remote.setMessages({
      // 説明だけ：説明の 1 行目がタイトル
      [id(1)]: { content: "", embeds: [{ description: "1 行目\n2 行目" }] },
      // 最初の埋め込みはフィールドだけ：2 つ目から採る
      [id(2)]: {
        content: "",
        embeds: [{ fields: [{ name: "a", value: "b" }] }, { title: "2 つ目", description: "説明" }],
      },
      // どの埋め込みにもタイトルと説明がない：既定のタイトル、要約なし、本文は置く
      [id(3)]: { content: "", embeds: [{ fields: [{ name: "状態", value: "OK" }] }] },
      // 空白だけのテキストは、テキストのない投稿と同じ
      [id(4)]: { content: "  \n ", embeds: [{ title: "埋め込み" }] },
      // テキストと埋め込みの両方：タイトルと要約はテキストから、本文には両方
      [id(5)]: { content: "本文\n2 行目", embeds: [{ title: "埋め込み", description: "説明" }] },
    });
    await runFetchFeed(t.platform, t.feedId);

    expect(await t.article(id(1))).toMatchObject({
      title: "1 行目",
      summary: "1 行目\n2 行目",
      html: "<blockquote><p>1 行目<br>2 行目</p></blockquote>",
    });
    expect(await t.article(id(2))).toMatchObject({ title: "2 つ目", summary: "説明" });
    expect(await t.article(id(3))).toMatchObject({
      title: "Discord の投稿",
      summary: null,
      hasContent: true,
      html: "<blockquote><dl><dt>状態</dt><dd>OK</dd></dl></blockquote>",
    });
    expect(await t.article(id(4))).toMatchObject({
      title: "埋め込み",
      summary: null,
      html: "<blockquote><p><strong>埋め込み</strong></p></blockquote>",
    });
    expect(await t.article(id(5))).toMatchObject({
      title: "本文",
      summary: "本文\n2 行目",
      html: "<p>本文<br>2 行目</p><blockquote><p><strong>埋め込み</strong></p><p>説明</p></blockquote>",
    });
  });

  it("http ／ https でない URL はリンクにしない。添付だけの投稿には本文を置かない", async () => {
    const t = await subscribed();
    t.remote.setMessages({
      [id(1)]: { content: "", embeds: [{ title: "危ない", url: "javascript:alert(1)" }] },
      [id(2)]: { content: "", attachments: [{ id: "9", url: "https://cdn.discordapp.com/a.png" }] },
    });
    await runFetchFeed(t.platform, t.feedId);

    expect((await t.article(id(1))).html).toBe(
      "<blockquote><p><strong>危ない</strong></p></blockquote>",
    );
    expect(await t.article(id(2))).toMatchObject({
      title: "Discord の投稿",
      summary: null,
      hasContent: false,
      html: null,
    });
  });

  it("形の崩れた埋め込みは、その値だけを使わず、ほかの値とほかの投稿を取り込む", async () => {
    const t = await subscribed();
    t.remote.setMessages({
      [id(1)]: {
        content: "",
        embeds: [
          "not an object",
          null,
          {
            title: 123,
            author: "名前ではない",
            fields: "not a list",
            footer: { text: ["x"] },
            description: "読める説明",
          },
          { fields: [null, { name: 1, value: "値だけ" }] },
        ],
      },
      [id(2)]: { content: "ほかの投稿" },
    });
    expect(await runFetchFeed(t.platform, t.feedId)).toEqual({ status: "fetched", inserted: 2 });

    expect(await t.article(id(1))).toMatchObject({
      title: "読める説明",
      html: "<blockquote><p>読める説明</p></blockquote><blockquote><dl><dt></dt><dd>値だけ</dd></dl></blockquote>",
    });
    expect(await t.article(id(2))).toMatchObject({ title: "ほかの投稿", hasContent: true });
  });

  it("本文を置いたあと記事の行を入れる前に落ちても、やり直すと本文付きで入る", async () => {
    const failing = statementHook(/insert into articles/i, async () => {
      throw new Error("落ちた");
    });
    const t = await subscribed({ db: failing.db });
    t.remote.setMessages({ [id(1)]: { content: "テキスト" } });

    await expect(runFetchFeed(t.platform, t.feedId)).rejects.toThrow();
    expect(failing.fired()).toBe(true);
    // 置いた本文の名前の書き留めが残り、1 日 1 回の片付けが消せる
    const left = await t.platform.db.select().from(contentNotes).all();
    expect(left.length).toBeGreaterThan(0);
    expect(
      await t.platform.db.select().from(articles).where(eq(articles.feedId, t.feedId)),
    ).toEqual([]);

    expect(await runFetchFeed(t.platform, t.feedId)).toEqual({ status: "fetched", inserted: 1 });
    const [row] = await t.platform.db.select().from(articles).where(eq(articles.feedId, t.feedId));
    expect(row?.contentKey).toMatch(/^feed\/[0-9a-f]{32}$/);
    expect(await t.platform.content.get(row?.contentKey ?? "")).toBe("<p>テキスト</p>");
    // 前の実行の名前は行に入らないので、書き留めは残る。今回の名前は消える
    const notes = (await t.platform.db.select().from(contentNotes).all()).map(({ key }) => key);
    expect(notes).not.toContain(row?.contentKey);
    expect(notes).toEqual(expect.arrayContaining(left.map(({ key }) => key)));
  });

  it("取得中に購読を解除したら、記事の行を入れず、置いた本文は書き留めから片付けられる", async () => {
    const t = await subscribed();
    t.remote.setMessages({ [id(1)]: { content: "テキスト" } });
    t.remote.beforeMessages(() => disconnectDiscord(t.platform.db, t.user.id));
    const before = new Set(
      (await t.platform.db.select().from(contentNotes).all()).map(({ key }) => key),
    );

    await runFetchFeed(t.platform, t.feedId);

    expect(
      await t.platform.db.select().from(articles).where(eq(articles.feedId, t.feedId)),
    ).toEqual([]);
    const notes = (await t.platform.db.select().from(contentNotes).all()).filter(
      ({ key }) => !before.has(key),
    );
    expect(notes).toHaveLength(1);
    expect(await t.platform.content.get(notes[0]?.key ?? "")).toBe("<p>テキスト</p>");
    for (const { key } of notes) {
      expect(
        await t.platform.db.select().from(articles).where(eq(articles.contentKey, key)),
      ).toEqual([]);
    }
  });
});
