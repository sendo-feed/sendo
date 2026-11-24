import { createClient } from "@libsql/client";
import { eq } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { connectDiscord, disconnectDiscord, insertDiscordArticles } from "../../src/db/discord";
import { findFeedByUrl, getFeed } from "../../src/db/feeds";
import { articles, contentNotes, feeds, pageContents, users } from "../../src/db/schema";
import { createSession } from "../../src/db/sessions";
import { readStorageUsage } from "../../src/db/storage";
import { subscribeMany } from "../../src/db/subscriptions";
import { runJob } from "../../src/jobs";
import { runFetchFeed } from "../../src/jobs/fetch-feed";
import { enqueueDueFeeds } from "../../src/jobs/schedule";
import type { Platform } from "../../src/platform";
import { startDiscordIngestion } from "../../src/platform/node/discord-ingestion";
import { createSqliteJobQueue } from "../../src/platform/node/job-queue";
import { MIGRATIONS_DIR, openTestDatabase } from "../db";
import { fakeDiscordGateway } from "../fixtures/discord-gateway";
import { PNG } from "../fixtures/images";
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
  let beforeGuildRead: (() => Promise<Response | undefined>) | undefined;
  let beforeChannelRead: (() => Promise<void>) | undefined;
  let messageStatus = 200;
  let retryAfter = "3600.5";
  let errorCode: number | undefined;
  let messageIds = [MESSAGE_ID];
  let systemIds: string[] = [];
  let bodies = new Map<string, Record<string, unknown>>();
  let guildIcon: unknown = null;
  let deniedMember = DISCORD_USER;
  // discord.com のサイト（API の外）。サーバーにアイコンがないときに、Discord のアイコンを探す先
  // （docs/decisions/discord.md の 7）。既定では何もない
  let site: (path: string) => Response | Promise<Response> = () =>
    new Response(null, { status: 404 });
  const siteCalls: string[] = [];
  const result = fakeFetch(async (url, init) => {
    expect(url.origin).toBe("https://discord.com");
    expect(init?.redirect).toBe("manual");
    const path = url.pathname;
    if (!path.startsWith("/api/")) {
      // 読者や Bot のことを渡さない
      expect(new Headers(init?.headers).get("authorization")).toBeNull();
      siteCalls.push(path);
      return site(path);
    }
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
    if (path === "/api/v10/gateway/bot") {
      return Response.json({
        url: "wss://gateway.discord.gg",
        session_start_limit: { remaining: 999, reset_after: 86_400_000 },
      });
    }
    if (path === "/api/v10/guilds/201") {
      const override = await beforeGuildRead?.();
      if (override) return override;
      return Response.json({
        owner_id: "104",
        icon: guildIcon,
        roles: [{ id: "201", permissions: READ }],
      });
    }
    if (path === "/api/v10/channels/301" || path === "/api/v10/channels/302") {
      await beforeChannelRead?.();
      return Response.json({
        id: path.endsWith("301") ? "301" : "302",
        guild_id: "201",
        type: 5,
        name: "releases",
        permission_overwrites: canRead
          ? []
          : [{ id: deniedMember, type: 1, deny: READ, allow: "0" }],
      });
    }
    if (path.startsWith("/api/v10/guilds/201/members/")) {
      const override = await beforeGuildRead?.();
      if (override) return override;
      return Response.json({ roles: [] });
    }
    if (path === "/api/v10/channels/301/messages" || path === "/api/v10/channels/302/messages") {
      const channelId = path.includes("/301/") ? "301" : "302";
      if (beforeMessages) await beforeMessages();
      if (messageStatus !== 200) {
        return Response.json(
          { code: errorCode },
          { status: messageStatus, headers: { "retry-after": retryAfter } },
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
          channel_id: channelId,
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
    deny: (member = DISCORD_USER) => {
      canRead = false;
      deniedMember = member;
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
    setGuildIcon: (icon: unknown) => {
      guildIcon = icon;
    },
    /** discord.com のサイトの応答を差し替える */
    setSite: (handler: (path: string) => Response | Promise<Response>) => {
      site = handler;
    },
    /** discord.com のサイトに届いた要求のパス */
    siteCalls,
    setMessageStatus: (status: number, code?: number, wait = "3600.5") => {
      messageStatus = status;
      retryAfter = wait;
      errorCode = code;
    },
    beforeMessages: (fn: () => Promise<void>) => {
      beforeMessages = fn;
    },
    beforeGuildRead: (fn: () => Promise<Response | undefined>) => {
      beforeGuildRead = fn;
    },
    beforeChannelRead: (fn: () => Promise<void>) => {
      beforeChannelRead = fn;
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

async function subscribe(request: Awaited<ReturnType<typeof browser>>, url = CHANNEL) {
  const result = await request(`${BASE}/subscriptions`, { method: "POST", json: { url } });
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
      { type: "fetch-discord", feedId },
      { type: "fetch-discord", feedId: otherFeed },
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
    // 全文は、ページを取りにいかずに置いた本文を返す（docs/decisions/discord.md の 6）
    const content = await requestApp(
      platform,
      `/api/v1/articles/${first?.id}/content?source=page`,
      {
        token: owner.token,
      },
    );
    expect(content.status).toBe(200);
    expect(remote.calls).toHaveLength(fetchCount);
    // ほかの人の投稿の全文は、ないものとして返す
    const others = await requestApp(platform, `/api/v1/articles/${first?.id}/content?source=page`, {
      token: other.token,
    });
    expect(others.status).toBe(404);
    expect(await others.json()).toMatchObject({ error: { code: "not_found" } });
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

  it("サーバーのアイコンをフィードのアイコンにし、変わったときだけ同期に届ける（docs/decisions/discord.md の 7）", async () => {
    const { platform, remote } = await setup();
    const user = await createUser();
    await connectDiscord(platform.db, user.id, DISCORD_USER);
    const feedId = await subscribe(await browser(platform, user.id));
    const get = async <T>(path: string) => {
      const res = await requestApp(platform, path, { token: user.token });
      expect(res.status).toBe(200);
      return (await res.json()) as T;
    };
    type Sync = { cursor: string; feeds: { id: string; iconUrl: string | null }[] };
    const relayed = (url: string | null | undefined) =>
      url ? new URL(url, ORIGIN).searchParams.get("url") : url;
    const fetchAgain = async () => {
      // 同じ時刻のまま取り直すので、前回の取得の記録を外す
      await platform.db.update(feeds).set({ lastFetchedAt: null }).where(eq(feeds.id, feedId));
      await runFetchFeed(platform, feedId);
    };
    const icon = (n: string) => n.repeat(32);
    const cdn = (hash: string) => `https://cdn.discordapp.com/icons/201/${hash}.png`;

    remote.setGuildIcon(icon("a"));
    await runFetchFeed(platform, feedId);
    expect((await getFeed(platform.db, feedId))?.iconUrl).toBe(cdn(icon("a")));
    const first = await get<Sync>("/api/v1/sync");
    expect(relayed(first.feeds.find((feed) => feed.id === feedId)?.iconUrl)).toBe(cdn(icon("a")));
    const list = await get<{ items: { id: string; iconUrl: string | null }[] }>("/api/v1/feeds");
    expect(relayed(list.items.find((feed) => feed.id === feedId)?.iconUrl)).toBe(cdn(icon("a")));

    // 同じアイコンなら、同期には何も届かない
    await fetchAgain();
    const unchanged = await get<Sync>(`/api/v1/sync?cursor=${first.cursor}`);
    expect(unchanged.feeds).toEqual([]);

    // 動くアイコン（a_）も、静止画の png で取る
    remote.setGuildIcon(`a_${icon("b")}`);
    await fetchAgain();
    const changed = await get<Sync>(`/api/v1/sync?cursor=${unchanged.cursor}`);
    expect(changed.feeds.map((feed) => relayed(feed.iconUrl))).toEqual([cdn(`a_${icon("b")}`)]);

    // 形の違う値では、今のアイコンを変えない
    // 項目がないときも同じ
    for (const malformed of ["../../evil", icon("G"), 123, `${icon("c")}.png`, undefined]) {
      remote.setGuildIcon(malformed);
      await fetchAgain();
      expect((await getFeed(platform.db, feedId))?.iconUrl).toBe(cdn(`a_${icon("b")}`));
    }
    const kept = await get<Sync>(`/api/v1/sync?cursor=${changed.cursor}`);
    expect(kept.feeds).toEqual([]);

    // アイコンを外すと null になり、同期に届く
    remote.setGuildIcon(null);
    await fetchAgain();
    const removed = await get<Sync>(`/api/v1/sync?cursor=${kept.cursor}`);
    expect(removed.feeds).toMatchObject([{ id: feedId, iconUrl: null }]);
    expect(remote.calls.some((call) => call.url.startsWith("https://cdn.discordapp.com/"))).toBe(
      false,
    );
  });

  it("閲覧権限の喪失で、投稿と購読の削除を同期に届ける", async () => {
    const { platform, remote } = await setup();
    const user = await createUser();
    await connectDiscord(platform.db, user.id, DISCORD_USER);
    const request = await browser(platform, user.id);
    const feedId = await subscribe(request);
    remote.setGuildIcon("f".repeat(32));
    await runFetchFeed(platform, feedId);
    expect((await getFeed(platform.db, feedId))?.iconUrl).not.toBeNull();
    const sync = async (cursor?: string) => {
      const url = `/api/v1/sync${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`;
      const response = await requestApp(platform, url, { token: user.token });
      expect(response.status).toBe(200);
      return (await response.json()) as {
        cursor: string;
        feeds: { id: string; deleted: boolean; iconUrl: string | null }[];
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
    // 外すときは、Discord のアイコンを探しにいかない
    expect(remote.siteCalls).toEqual([]);
    const changed = await sync(initial.cursor);
    // 外したフィードには、サーバーのアイコンも残さない
    expect(changed.feeds).toMatchObject([{ id: feedId, deleted: true, iconUrl: null }]);
    expect(await getFeed(platform.db, feedId)).toMatchObject({
      iconUrl: null,
      iconCheckedAt: null,
    });
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
    remote.setGuildIcon("f".repeat(32));
    remote.beforeMessages(() => disconnectDiscord(platform.db, user.id));
    await runFetchFeed(platform, feedId);
    expect(await platform.db.select().from(articles).where(eq(articles.feedId, feedId))).toEqual(
      [],
    );
    expect(await getFeed(platform.db, feedId)).toMatchObject({
      discordConnectionId: null,
      lastSuccessfulFetchAt: null,
      iconUrl: null,
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
    const contentOf = async (guid: string) => {
      const [row] = await platform.db
        .select({ contentKey: articles.contentKey })
        .from(articles)
        .where(eq(articles.guid, guid));
      return row?.contentKey ? await platform.content.get(row.contentKey) : null;
    };
    const body = "<p>Version 1.0<br>&lt;script&gt;literal text&lt;/script&gt;</p>";
    expect(await stored()).toEqual([{ guid: newerId }]);
    expect(await contentOf(newerId)).toBe(body);
    expect((await getFeed(platform.db, feedId))?.discordCursor).toBe(startCursor);
    expect(enqueued).toContainEqual({ type: "clean-up" });

    platform.retentionConfig = { maxBytes: baseline + 32 * 1024 };
    expect(await runFetchFeed(platform, feedId)).toEqual({ status: "fetched", inserted: 1 });
    expect(await stored()).toEqual([{ guid: MESSAGE_ID }, { guid: newerId }]);
    // 容量が足りずに見送った投稿も、取り直すと本文付きで入る
    expect(await contentOf(MESSAGE_ID)).toBe(body);
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

describe("Discord の取得ジョブ", () => {
  async function subscribeWithQueue() {
    const database = await openTestDatabase();
    onTestFinished(() => database.cleanup());
    let clock = FIXED_NOW.getTime();
    const now = () => new Date(clock);
    const advanceTo = (at: number) => {
      clock = at;
    };
    const jobs = createSqliteJobQueue(database.db, { now });
    const remote = discordFetch();
    remote.setGuildIcon("a".repeat(32));
    const { platform } = createTestPlatform({
      db: database.db,
      discord: CONFIG,
      fetch: remote.fetch,
      jobs,
      now,
    });
    const userId = crypto.randomUUID();
    await database.db
      .insert(users)
      .values({ id: userId, email: "discord-queue@example.com", createdAt: now() })
      .run();
    await connectDiscord(database.db, userId, DISCORD_USER);
    const request = await browser(platform, userId);
    const feedId = await subscribe(request);
    const requestFetch = () => jobs.enqueue([{ type: "fetch-discord", feedId }]);
    const runDue = () => jobs.runDue((job) => runJob(platform, job));
    const messageCalls = () =>
      remote.calls.filter(({ url }) => new URL(url).pathname.endsWith("/messages")).length;
    const stored = () =>
      database.db.select({ guid: articles.guid }).from(articles).orderBy(articles.guid);
    return {
      advanceTo,
      now,
      platform,
      remote,
      feedId,
      request,
      requestFetch,
      runDue,
      messageCalls,
      stored,
    };
  }

  it.each([200, 503])(
    "並行取得で同じ権限照会を共有し、HTTP %s のあとも次回は照会し直す",
    async (status) => {
      const t = await subscribeWithQueue();
      const other = await subscribe(t.request, "https://discord.com/channels/201/302");
      const calls = (path: string) =>
        t.remote.calls.filter(({ url }) => new URL(url).pathname === `/api/v10${path}`).length;
      t.remote.calls.length = 0;
      const guild = Promise.withResolvers<void>();
      t.remote.beforeGuildRead(async () => {
        await guild.promise;
        return status === 503 ? new Response(null, { status }) : undefined;
      });
      const running = t.runDue();
      try {
        await vi.waitFor(() => expect(calls("/channels/302")).toBe(1));
        expect(calls("/channels/301")).toBe(1);
        expect(calls("/guilds/201")).toBe(1);
      } finally {
        guild.resolve();
        expect(await running).toBe(2);
      }
      for (const path of [`/guilds/201/members/${DISCORD_USER}`, "/guilds/201/members/101"]) {
        expect(calls(path)).toBe(1);
      }
      expect(t.messageCalls()).toBe(status === 200 ? 2 : 0);
      if (status === 200) expect(await t.stored()).toHaveLength(2);

      const feed = await getFeed(t.platform.db, t.feedId);
      if (!feed) throw new Error("missing feed");
      t.advanceTo(feed.nextFetchAt.getTime());
      t.remote.beforeGuildRead(async () => undefined);
      t.remote.deny();
      await t.requestFetch();
      expect(await t.runDue()).toBe(1);
      expect(calls("/guilds/201")).toBe(2);
      expect((await getFeed(t.platform.db, t.feedId))?.discordConnectionId).toBeNull();
      expect((await getFeed(t.platform.db, other))?.discordConnectionId).not.toBeNull();
    },
  );

  it("同じチャンネルの照会を共有しても、別の利用者の権限と配布を混ぜない", async () => {
    const t = await subscribeWithQueue();
    const anotherUser = crypto.randomUUID();
    await t.platform.db
      .insert(users)
      .values({ id: anotherUser, email: "another-discord-queue@example.com", createdAt: t.now() })
      .run();
    await connectDiscord(t.platform.db, anotherUser, SECOND_DISCORD_USER);
    const otherRequest = await browser(t.platform, anotherUser);
    const other = await subscribe(otherRequest);
    t.remote.deny(SECOND_DISCORD_USER);
    t.remote.calls.length = 0;
    const sharedPermission = Promise.withResolvers<void>();
    t.remote.beforeChannelRead(() => sharedPermission.promise);
    t.remote.beforeGuildRead(async () => {
      await sharedPermission.promise;
      return undefined;
    });
    const calls = (path: string) =>
      t.remote.calls.filter(({ url }) => new URL(url).pathname === `/api/v10${path}`).length;
    const running = t.runDue();
    try {
      await vi.waitFor(() => {
        expect(calls(`/guilds/201/members/${SECOND_DISCORD_USER}`)).toBe(1);
        expect(calls(`/guilds/201/members/${DISCORD_USER}`)).toBe(1);
      });
      for (const path of [
        "/channels/301",
        "/guilds/201",
        "/guilds/201/members/101",
        `/guilds/201/members/${DISCORD_USER}`,
      ]) {
        expect(calls(path)).toBe(1);
      }
    } finally {
      sharedPermission.resolve();
      expect(await running).toBe(2);
    }
    expect((await getFeed(t.platform.db, other))?.discordConnectionId).toBeNull();
    expect((await getFeed(t.platform.db, t.feedId))?.discordConnectionId).not.toBeNull();
    expect(t.messageCalls()).toBe(1);
    expect(await t.stored()).toEqual([{ guid: MESSAGE_ID }]);
    expect(await (await t.request("/api/v1/sync")).json()).toMatchObject({
      articles: [{ url: `${CHANNEL}/${MESSAGE_ID}` }],
    });
    expect(await (await otherRequest("/api/v1/sync")).json()).toMatchObject({ articles: [] });
  });

  it("初回と定期の取得を重ねず、取得中の新着をまとめてページを最後まで追う", async () => {
    const t = await subscribeWithQueue();
    expect(await enqueueDueFeeds(t.platform)).toBe(0);
    expect(await t.runDue()).toBe(1);
    expect(await t.runDue()).toBe(0);

    let entered = () => {};
    let release = () => {};
    const enteredMessages = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const responseReady = new Promise<void>((resolve) => {
      release = resolve;
    });
    t.remote.beforeMessages(async () => {
      entered();
      await responseReady;
    });
    t.advanceTo(FIXED_NOW.getTime() + 1);
    await t.requestFetch();
    const inFlight = t.runDue();
    try {
      await enteredMessages;
      const ids = Array.from({ length: 31 }, (_, index) =>
        messageIdAt(FIXED_NOW.getTime() + index + 1),
      );
      t.remote.setMessageIds([MESSAGE_ID, ...ids]);
      await Promise.all([t.requestFetch(), t.requestFetch(), t.requestFetch()]);
      expect(await t.runDue()).toBe(0);
    } finally {
      release();
      await inFlight;
    }
    t.advanceTo(FIXED_NOW.getTime() + 50);
    expect(await t.runDue()).toBe(1);
    expect(await t.runDue()).toBe(0);
    expect(await t.stored()).toHaveLength(32);
    expect(t.messageCalls()).toBe(3);
  });

  it("開始時刻が同じ取得でも、カーソルを記録して 3 ページ目まで取り込む", async () => {
    const t = await subscribeWithQueue();
    expect(await t.runDue()).toBe(1);
    const clock = FIXED_NOW.getTime();
    const ids = Array.from({ length: 61 }, (_, index) => messageIdAt(clock + index + 1));
    t.remote.setMessageIds([MESSAGE_ID, ...ids]);
    t.advanceTo(clock + 100);
    await t.requestFetch();

    expect(await t.runDue()).toBe(1);
    expect(await t.runDue()).toBe(1);
    expect(await t.runDue()).toBe(1);
    expect(await t.runDue()).toBe(0);
    expect(await t.stored()).toEqual([MESSAGE_ID, ...ids].map((guid) => ({ guid })));
    expect((await getFeed(t.platform.db, t.feedId))?.discordCursor).toBe(ids.at(-1));
  });

  it("Gateway の新着と再接続を起点に受信箱と差分同期に配る", async () => {
    const t = await subscribeWithQueue();
    expect(await t.runDue()).toBe(1);
    const sync = async (cursor?: string) => {
      const path = cursor ? `/api/v1/sync?cursor=${encodeURIComponent(cursor)}` : "/api/v1/sync";
      const response = await t.request(path);
      expect(response.status).toBe(200);
      return (await response.json()) as { cursor: string; articles: { url: string }[] };
    };
    const first = await sync();
    const notify = vi.fn(async () => {});
    t.platform.syncUpdates = { ...t.platform.syncUpdates, notify };

    const fake = fakeDiscordGateway();
    const ingestion = startDiscordIngestion(t.platform, fake.connect);
    if (!ingestion) throw new Error("Discord Gateway was not started");
    onTestFinished(() => ingestion.stop());
    const clock = FIXED_NOW.getTime();
    const runNext = async (offset: number) => {
      t.advanceTo(clock + offset);
      await vi.waitFor(async () => expect(await t.runDue()).toBe(1), { timeout: 2_500 });
    };

    const initial = await vi.waitFor(() => fake.socket());
    initial.hello();
    initial.ready();
    await runNext(100);
    const nextId = messageIdAt(clock + 101);
    t.remote.setMessageIds([MESSAGE_ID, nextId]);
    const enqueue = vi.spyOn(t.platform.jobs, "enqueue");
    enqueue.mockRejectedValueOnce(new Error("queue is busy"));
    initial.receive(0, { guild_id: "201", channel_id: "301" }, { s: 3, t: "MESSAGE_CREATE" });
    await runNext(101);
    expect(await t.runDue()).toBe(0);
    const request = [{ type: "fetch-discord", feedId: t.feedId }];
    expect(enqueue.mock.calls).toEqual([[request], [request]]);
    enqueue.mockRestore();
    const live = await sync(first.cursor);
    expect(live.articles).toMatchObject([{ url: `${CHANNEL}/${nextId}` }]);
    expect(notify).toHaveBeenCalledOnce();

    initial.receive(9, false);
    const reconnected = await vi.waitFor(() => fake.socket(1), { timeout: 6_000 });
    reconnected.hello();
    expect(reconnected.sent[0]).toMatchObject({ op: 2 });
    const missed = Array.from({ length: 31 }, (_, index) => messageIdAt(clock + index + 102));
    t.remote.setMessageIds([MESSAGE_ID, nextId, ...missed]);
    reconnected.ready();
    await runNext(200);
    await runNext(201);
    expect(await t.runDue()).toBe(0);
    expect((await sync(live.cursor)).articles.map((item) => item.url).sort()).toEqual(
      missed.map((id) => `${CHANNEL}/${id}`).sort(),
    );

    t.remote.deny();
    reconnected.receive(0, { guild_id: "201", channel_id: "301" }, { s: 2, t: "MESSAGE_CREATE" });
    await runNext(300);
    expect(await t.stored()).toEqual([]);
    expect(t.messageCalls()).toBe(5);
  }, 10_000);

  it("再送された投稿を、キュー投入に 3 回失敗しても DB の復旧後に取り込む", async () => {
    const t = await subscribeWithQueue();
    expect(await t.runDue()).toBe(1);
    const fake = fakeDiscordGateway();
    const ingestion = startDiscordIngestion(t.platform, fake.connect);
    if (!ingestion) throw new Error("Discord Gateway was not started");
    onTestFinished(() => ingestion.stop());
    const first = await vi.waitFor(() => fake.socket());
    first.hello();
    first.ready();
    const clock = FIXED_NOW.getTime();
    t.advanceTo(clock + 100);
    await vi.waitFor(async () => expect(await t.runDue()).toBe(1));

    first.receive(7, null);
    const resumed = await vi.waitFor(() => fake.socket(1), { timeout: 2_500 });
    resumed.hello();
    expect(resumed.sent[0]).toMatchObject({ op: 6, d: { seq: 1 } });
    const posted = messageIdAt(clock + 101);
    t.remote.setMessageIds([MESSAGE_ID, posted]);
    t.advanceTo(clock + 200);
    const enqueue = vi.spyOn(t.platform.jobs, "enqueue");
    onTestFinished(() => enqueue.mockRestore());
    const error = new Error("queue is busy");
    enqueue.mockRejectedValueOnce(error).mockRejectedValueOnce(error).mockRejectedValueOnce(error);
    resumed.receive(0, { guild_id: "201", channel_id: "301" }, { s: 2, t: "MESSAGE_CREATE" });
    resumed.receive(0, null, { s: 3, t: "RESUMED" });

    await vi.waitFor(async () => expect(await t.runDue()).toBe(1), { timeout: 8_000 });
    expect(enqueue).toHaveBeenCalledTimes(4);
    expect(await t.stored()).toContainEqual({ guid: posted });
  }, 12_000);

  it("Gateway の新着は購読中の該当チャンネルだけを起こす", async () => {
    const t = await subscribeWithQueue();
    const other = await subscribe(t.request, "https://discord.com/channels/201/302");
    expect(await t.runDue()).toBe(2);

    const fake = fakeDiscordGateway();
    const ingestion = startDiscordIngestion(t.platform, fake.connect);
    if (!ingestion) throw new Error("Discord Gateway was not started");
    onTestFinished(() => ingestion.stop());
    const socket = await vi.waitFor(() => fake.socket());
    const checkQueued = vi.spyOn(t.platform.jobs, "enqueue");
    socket.hello();
    socket.ready();
    t.advanceTo(FIXED_NOW.getTime() + 1);
    await vi.waitFor(() => expect(checkQueued).toHaveBeenCalledOnce());
    expect(await t.runDue()).toBe(2);
    checkQueued.mockClear();

    socket.receive(0, { guild_id: "201", channel_id: "400" }, { s: 2, t: "MESSAGE_CREATE" });
    socket.receive(0, { guild_id: "201", channel_id: "301" }, { s: 3, t: "MESSAGE_CREATE" });
    t.advanceTo(FIXED_NOW.getTime() + 2);
    await vi.waitFor(() => expect(checkQueued).toHaveBeenCalledOnce());
    expect(checkQueued).toHaveBeenCalledWith([{ type: "fetch-discord", feedId: t.feedId }]);
    expect(await t.runDue()).toBe(1);
    expect((await getFeed(t.platform.db, other))?.lastFetchedAt).toEqual(
      new Date(FIXED_NOW.getTime() + 1),
    );
  });

  it.each([429, 503])("%s の待機中は前倒しせず、期限以降に権限を確認する", async (status) => {
    const t = await subscribeWithQueue();
    expect(await t.runDue()).toBe(1);
    t.remote.setMessageStatus(status, undefined, "3600");
    // 直前の成功と同じ開始時刻でも、失敗と待機時刻を記録する。
    await t.requestFetch();
    expect(await t.runDue()).toBe(1);
    const next = (await getFeed(t.platform.db, t.feedId))?.nextFetchAt.getTime();
    expect(next).toBeGreaterThan(t.now().getTime());
    if (next === undefined) throw new Error("Discord feed disappeared");
    t.advanceTo(next - 1);
    await t.requestFetch();
    expect(await t.runDue()).toBe(0);
    expect(t.messageCalls()).toBe(2);
    t.remote.deny();
    t.advanceTo(next);
    expect(await t.runDue()).toBe(1);
    expect(t.messageCalls()).toBe(2);
    expect(await t.stored()).toEqual([]);
    expect((await getFeed(t.platform.db, t.feedId))?.discordConnectionId).toBeNull();
  });
});

describe("サーバーにアイコンがないときの Discord のアイコン（docs/decisions/discord.md の 7）", () => {
  const SITE_ICON = "https://discord.com/assets/favicon.png";
  const DAY = 24 * HOUR;
  const MONTH = 30 * DAY;
  const icon = (n: string) => n.repeat(32);
  const cdn = (hash: string) => `https://cdn.discordapp.com/icons/201/${hash}.png`;
  type Sync = { cursor: string; feeds: { id: string; iconUrl: string | null }[] };

  async function subscribed(overrides: Partial<Platform> = {}) {
    const remote = discordFetch();
    // ok：トップのページにアイコンがある。down：届かない。none：ページはあるがアイコンがない
    const state = { now: FIXED_NOW, site: "ok" as "ok" | "down" | "none" };
    remote.setSite((path) => {
      if (state.site === "down") return new Response(null, { status: 503 });
      if (path === "/" && state.site === "none") return new Response("<html></html>");
      if (path === "/") return new Response('<link rel="icon" href="/assets/favicon.png">');
      if (path === "/assets/favicon.png") return new Response(PNG);
      return new Response(null, { status: 404 });
    });
    const { platform } = createTestPlatform({
      discord: CONFIG,
      fetch: remote.fetch,
      now: () => state.now,
      ...overrides,
    });
    const user = await createUser();
    await connectDiscord(platform.db, user.id, DISCORD_USER);
    const request = await browser(platform, user.id);
    const feedId = await subscribe(request);
    const fetchAt = async (ms: number) => {
      state.now = new Date(FIXED_NOW.getTime() + ms);
      expect(await runFetchFeed(platform, feedId)).toMatchObject({
        status: expect.stringMatching(/^(fetched|not-modified)$/),
      });
      return getFeed(platform.db, feedId);
    };
    const sync = async (cursor?: string) => {
      const res = await requestApp(
        platform,
        `/api/v1/sync${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
        { token: user.token },
      );
      expect(res.status).toBe(200);
      return (await res.json()) as Sync;
    };
    const relayed = (url: string | null | undefined) =>
      url ? new URL(url, ORIGIN).searchParams.get("url") : url;
    return { platform, remote, state, user, request, feedId, fetchAt, sync, relayed };
  }

  it("discord.com で見つけたアイコンを記録して同期に届け、30 日たつまで探し直さない", async () => {
    const t = await subscribed();
    const first = await t.fetchAt(0);
    expect(first).toMatchObject({ iconUrl: SITE_ICON, iconCheckedAt: FIXED_NOW });
    // チャンネルのページではなく、discord.com のトップを探す
    expect(t.remote.siteCalls).toEqual(["/", "/assets/favicon.png"]);
    const synced = await t.sync();
    expect(t.relayed(synced.feeds.find((feed) => feed.id === t.feedId)?.iconUrl)).toBe(SITE_ICON);
    const list = await requestApp(t.platform, "/api/v1/feeds", { token: t.user.token });
    const items = ((await list.json()) as { items: { id: string; iconUrl: string | null }[] })
      .items;
    expect(t.relayed(items.find((feed) => feed.id === t.feedId)?.iconUrl)).toBe(SITE_ICON);

    // 30 日たたないうちは探しにいかず、同期にも何も届かない
    await t.fetchAt(HOUR);
    await t.fetchAt(MONTH - 1);
    expect(t.remote.siteCalls).toHaveLength(2);
    expect((await t.sync(synced.cursor)).feeds).toEqual([]);

    // 30 日ちょうどで探し直す
    expect(await t.fetchAt(MONTH)).toMatchObject({
      iconUrl: SITE_ICON,
      iconCheckedAt: new Date(FIXED_NOW.getTime() + MONTH),
    });
    expect(t.remote.siteCalls).toHaveLength(4);
  });

  it("届かないときは、初めてなら null にし、前に見つけたアイコンは確かめずに残す。どちらも 30 日待つ", async () => {
    const t = await subscribed();
    t.state.site = "down";
    const first = await t.fetchAt(0);
    // フィードの取得は成功のまま
    expect(first).toMatchObject({
      iconUrl: null,
      iconCheckedAt: FIXED_NOW,
      lastSuccessfulFetchAt: FIXED_NOW,
      errorCount: 0,
    });
    const tried = t.remote.siteCalls.length;
    expect(tried).toBeGreaterThan(0);
    await t.fetchAt(HOUR);
    expect(t.remote.siteCalls).toHaveLength(tried);

    t.state.site = "ok";
    expect(await t.fetchAt(MONTH)).toMatchObject({ iconUrl: SITE_ICON });
    const synced = await t.sync();

    // 届かなくても、前に見つけたアイコンは確かめずに残し、同期にも届かない
    t.state.site = "down";
    const before = t.remote.siteCalls.length;
    const kept = await t.fetchAt(2 * MONTH);
    expect(kept).toMatchObject({
      iconUrl: SITE_ICON,
      iconCheckedAt: new Date(FIXED_NOW.getTime() + 2 * MONTH),
    });
    expect(t.remote.siteCalls.length).toBeGreaterThan(before);
    expect(t.remote.siteCalls.slice(before)).not.toContain("/assets/favicon.png");
    expect((await t.sync(synced.cursor)).feeds).toEqual([]);

    // ページにアイコンがないときも、前に見つけたアイコンを残す
    t.state.site = "none";
    expect(await t.fetchAt(3 * MONTH)).toMatchObject({ iconUrl: SITE_ICON });
  });

  it("サーバーのアイコンが付いたらすぐ替え、消えたら 30 日によらず探す。消えたサーバーのアイコンは残さない", async () => {
    const t = await subscribed();
    await t.fetchAt(0);
    const searched = t.remote.siteCalls.length;

    // 付いたら、次の取得でサーバーのアイコンに替える。探した時刻は進めない
    t.remote.setGuildIcon(icon("a"));
    expect(await t.fetchAt(HOUR)).toMatchObject({
      iconUrl: cdn(icon("a")),
      iconCheckedAt: FIXED_NOW,
    });
    expect(t.remote.siteCalls).toHaveLength(searched);

    // 消えたら、30 日たっていなくても探す。届かなくても、消えたサーバーのアイコンは残さない
    t.remote.setGuildIcon(null);
    t.state.site = "down";
    expect(await t.fetchAt(2 * HOUR)).toMatchObject({
      iconUrl: null,
      iconCheckedAt: new Date(FIXED_NOW.getTime() + 2 * HOUR),
    });
    expect(t.remote.siteCalls.length).toBeGreaterThan(searched);

    // もう一度付いて消えたら、すぐに探して、見つけたアイコンにする
    t.remote.setGuildIcon(icon("b"));
    await t.fetchAt(3 * HOUR);
    t.remote.setGuildIcon(null);
    t.state.site = "ok";
    expect(await t.fetchAt(4 * HOUR)).toMatchObject({ iconUrl: SITE_ICON });
  });

  it("サーバーの icon が読めないときは、アイコンを変えず、探しもしない", async () => {
    const t = await subscribed();
    const malformed = [undefined, "../../evil", 123];
    for (const [i, value] of malformed.entries()) {
      t.remote.setGuildIcon(value);
      expect(await t.fetchAt(i * HOUR)).toMatchObject({
        iconUrl: null,
        iconCheckedAt: null,
        lastFetchedAt: new Date(FIXED_NOW.getTime() + i * HOUR),
      });
    }
    // サーバーのアイコンがあるときも、消さず、探しもしない
    t.remote.setGuildIcon(icon("a"));
    await t.fetchAt(DAY);
    for (const [i, value] of malformed.entries()) {
      t.remote.setGuildIcon(value);
      expect(await t.fetchAt(DAY + (i + 1) * HOUR)).toMatchObject({
        iconUrl: cdn(icon("a")),
        lastFetchedAt: new Date(FIXED_NOW.getTime() + DAY + (i + 1) * HOUR),
      });
    }
    expect(t.remote.siteCalls).toEqual([]);
  });

  it("探した結果を記録する前に落ちても、次の取得で探し直す。消えたサーバーのアイコンも残らない", async () => {
    const failing = statementHook(
      /update "feeds" set "icon_url"/i,
      async () => {
        throw new Error("落ちた");
      },
      { armed: false },
    );
    const t = await subscribed({ db: failing.db });
    t.remote.setGuildIcon(icon("a"));
    await t.fetchAt(0);

    // サーバーのアイコンが消えた取得で、探した結果を記録する前に落ちる
    t.remote.setGuildIcon(null);
    failing.arm();
    t.state.now = new Date(FIXED_NOW.getTime() + HOUR);
    // DB の失敗は仕事の失敗にし、キューのやり直しに回す。フィードの取得は成功として残る
    await expect(runFetchFeed(t.platform, t.feedId)).rejects.toThrow();
    expect(failing.fired()).toBe(true);
    expect(await getFeed(t.platform.db, t.feedId)).toMatchObject({
      iconUrl: cdn(icon("a")),
      iconCheckedAt: null,
      lastFetchedAt: new Date(FIXED_NOW.getTime() + HOUR),
      lastSuccessfulFetchAt: new Date(FIXED_NOW.getTime() + HOUR),
      lastError: null,
      errorCount: 0,
    });

    // 次の取得で、30 日を待たずに探し直す
    expect(await t.fetchAt(2 * HOUR)).toMatchObject({
      iconUrl: SITE_ICON,
      iconCheckedAt: new Date(FIXED_NOW.getTime() + 2 * HOUR),
    });
  });

  it("探している間に連携を解除したら、外したフィードにアイコンを書かない", async () => {
    const t = await subscribed();
    t.remote.setSite(async (path) => {
      if (path === "/") {
        const res = await t.request(BASE, { method: "DELETE" });
        expect(res.ok).toBe(true);
        return new Response('<link rel="icon" href="/assets/favicon.png">');
      }
      if (path === "/assets/favicon.png") return new Response(PNG);
      return new Response(null, { status: 404 });
    });
    await t.fetchAt(0);
    expect(await getFeed(t.platform.db, t.feedId)).toMatchObject({
      discordConnectionId: null,
      iconUrl: null,
      iconCheckedAt: null,
    });
  });

  it("探している間に、後から始めた取得がサーバーのアイコンを記録したら、探した結果で上書きしない", async () => {
    const t = await subscribed();
    let interleaved = false;
    t.remote.setSite(async (path) => {
      if (!interleaved) {
        interleaved = true;
        // 探している途中に、サーバーにアイコンが付き、後から始めた取得がそれを記録する
        t.remote.setGuildIcon(icon("a"));
        await t.fetchAt(HOUR);
      }
      if (path === "/") return new Response('<link rel="icon" href="/assets/favicon.png">');
      if (path === "/assets/favicon.png") return new Response(PNG);
      return new Response(null, { status: 404 });
    });
    t.state.now = FIXED_NOW;
    expect(await runFetchFeed(t.platform, t.feedId)).toMatchObject({ status: "fetched" });
    expect(await getFeed(t.platform.db, t.feedId)).toMatchObject({
      iconUrl: cdn(icon("a")),
      iconCheckedAt: null,
    });
  });

  it("消えたサーバーのアイコンが、探している間に同じ値で付き直しても、探した結果で上書きしない", async () => {
    const t = await subscribed();
    t.remote.setGuildIcon(icon("a"));
    await t.fetchAt(0);
    let interleaved = false;
    t.remote.setSite(async (path) => {
      if (!interleaved) {
        interleaved = true;
        // 同じアイコンが付き直し、後から始めた取得が同じ値を書き直す
        t.remote.setGuildIcon(icon("a"));
        await t.fetchAt(2 * HOUR);
      }
      if (path === "/") return new Response('<link rel="icon" href="/assets/favicon.png">');
      if (path === "/assets/favicon.png") return new Response(PNG);
      return new Response(null, { status: 404 });
    });
    t.remote.setGuildIcon(null);
    await t.fetchAt(HOUR);
    expect(await getFeed(t.platform.db, t.feedId)).toMatchObject({
      iconUrl: cdn(icon("a")),
      iconCheckedAt: null,
      lastFetchedAt: new Date(FIXED_NOW.getTime() + 2 * HOUR),
    });
  });

  it("マイグレーションで、前の実装が付けた Discord のフィードの探した時刻を空にする", async () => {
    const client = createClient({ url: ":memory:" });
    try {
      await client.execute("PRAGMA foreign_keys = ON");
      const migrations = readMigrationFiles({ migrationsFolder: MIGRATIONS_DIR });
      const index = migrations.findIndex((m) =>
        m.sql.some((statement) => statement.includes("discord.md の 7")),
      );
      expect(index).toBeGreaterThan(0);
      for (const migration of migrations.slice(0, index)) {
        for (const statement of migration.sql) await client.execute(statement);
      }
      // 前の実装：Discord のフィードは、サーバーのアイコンの記録と一緒に時刻が付いている
      for (const [id, cursor, iconUrl] of [
        ["discord-none", "'5'", "NULL"],
        ["discord-guild", "'5'", `'${cdn(icon("a"))}'`],
        ["public", "NULL", "'https://example.com/icon.png'"],
      ]) {
        await client.execute(
          `INSERT INTO feeds (id, url, created_at, next_fetch_at, discord_cursor, icon_url, icon_checked_at)
           VALUES ('${id}', 'https://example.com/${id}', 0, 0, ${cursor}, ${iconUrl}, 7)`,
        );
      }
      for (const migration of migrations.slice(index)) {
        for (const statement of migration.sql) await client.execute(statement);
      }
      const rows = await client.execute(
        "SELECT id, icon_url, icon_checked_at FROM feeds ORDER BY id",
      );
      expect(rows.rows.map((row) => ({ ...row }))).toEqual([
        { id: "discord-guild", icon_url: cdn(icon("a")), icon_checked_at: null },
        { id: "discord-none", icon_url: null, icon_checked_at: null },
        { id: "public", icon_url: "https://example.com/icon.png", icon_checked_at: 7 },
      ]);
    } finally {
      client.close();
    }
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
      // CR だけの改行も改行として扱う。タイトルは絵文字の途中で切らない
      [id(6)]: { content: `${"あ".repeat(119)}😀\r2 行目` },
      // CRLF は 1 つの改行。CRLF の空行は段落の区切り
      [id(7)]: { content: "1 行目\r\n2 行目\r\n\r\n次の段落" },
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
    expect(await t.article(id(6))).toMatchObject({
      title: "あ".repeat(119),
      html: `<p>${"あ".repeat(119)}😀<br>2 行目</p>`,
    });
    expect((await t.article(id(7))).html).toBe("<p>1 行目<br>2 行目</p><p>次の段落</p>");
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

  describe("全文（source=page）", () => {
    async function contentOf(t: Awaited<ReturnType<typeof subscribed>>, guid: string) {
      const { id: articleId } = await t.article(guid);
      const get = (source: "feed" | "page") =>
        requestApp(t.platform, `/api/v1/articles/${articleId}/content?source=${source}`, {
          token: t.user.token,
        });
      return { articleId, get };
    }

    async function contentKeyOf(t: Awaited<ReturnType<typeof subscribed>>, articleId: string) {
      const [row] = await t.platform.db
        .select({ contentKey: articles.contentKey })
        .from(articles)
        .where(eq(articles.id, articleId));
      if (!row?.contentKey) throw new Error("no content key");
      return row.contentKey;
    }

    it("ページを取りにいかずに、置いた本文を全文として返す。抜いた本文の表には書かない", async () => {
      const t = await subscribed();
      t.remote.setMessages({
        [id(1)]: {
          content: "テキスト https://example.com/a",
          embeds: [{ title: "埋め込み", url: "https://example.com/b", description: "説明" }],
        },
      });
      await runFetchFeed(t.platform, t.feedId);
      const { get } = await contentOf(t, id(1));
      const feed = await get("feed");
      expect(feed.status).toBe(200);
      const feedBody = (await feed.json()) as { html: string; source: string };
      const fetchCount = t.remote.calls.length;

      const page = await get("page");
      expect(page.status).toBe(200);
      expect(await page.json()).toEqual({ html: feedBody.html, source: "page" });
      expect(feedBody.html).toContain('<a href="https://example.com/b"');
      // 外へ取りにいかず、抜く処理（既定のテストの緩衝層は、呼ぶと落ちる）も呼ばない
      expect(t.remote.calls).toHaveLength(fetchCount);
      expect(await t.platform.db.select().from(pageContents).all()).toEqual([]);
      // 抜けなかった記録を付けないので、もう一度求めても同じに返る
      expect((await get("page")).status).toBe(200);
    });

    it("返すときにも、フィードの本文と同じにサニタイズし、画像を中継の URL にする", async () => {
      const t = await subscribed();
      t.remote.setMessages({ [id(1)]: { content: "テキスト" } });
      await runFetchFeed(t.platform, t.feedId);
      const { articleId, get } = await contentOf(t, id(1));
      // Discord の投稿の本文には画像が入らないので、置いた本文を直接書き換えて確かめる
      await t.platform.content.put(
        await contentKeyOf(t, articleId),
        '<p>テキスト<img src="https://example.com/a.png"><script>alert(1)</script></p>',
      );

      const feed = (await (await get("feed")).json()) as { html: string };
      const page = (await (await get("page")).json()) as { html: string };
      expect(page.html).toBe(feed.html);
      expect(page.html).toContain('src="/api/v1/images?url=');
      expect(page.html).not.toContain("script");
    });

    it("本文を置いていない投稿は、全文も 404（page_content_unavailable）", async () => {
      const t = await subscribed();
      t.remote.setMessages({
        [id(1)]: {
          content: "",
          attachments: [{ id: "9", url: "https://cdn.discordapp.com/a.png" }],
        },
      });
      await runFetchFeed(t.platform, t.feedId);
      const { get } = await contentOf(t, id(1));

      const page = await get("page");
      expect(page.status).toBe(404);
      expect(await page.json()).toMatchObject({ error: { code: "page_content_unavailable" } });
      expect(await t.platform.db.select().from(pageContents).all()).toEqual([]);
    });

    it("置き場から本文が消えていたら、全文は 404（page_content_unavailable）、フィードの本文は 404（no_content）", async () => {
      const t = await subscribed();
      t.remote.setMessages({ [id(1)]: { content: "テキスト" } });
      await runFetchFeed(t.platform, t.feedId);
      const { articleId, get } = await contentOf(t, id(1));
      await t.platform.content.delete([await contentKeyOf(t, articleId)]);

      const page = await get("page");
      expect(page.status).toBe(404);
      expect(await page.json()).toMatchObject({ error: { code: "page_content_unavailable" } });
      const feed = await get("feed");
      expect(feed.status).toBe(404);
      expect(await feed.json()).toMatchObject({ error: { code: "no_content" } });
      expect(await t.platform.db.select().from(pageContents).all()).toEqual([]);
    });

    it("置き場を読むのに失敗したら 5xx にし、抜けなかった記録を付けない。直ればまた返る", async () => {
      const t = await subscribed();
      t.remote.setMessages({ [id(1)]: { content: "テキスト" } });
      await runFetchFeed(t.platform, t.feedId);
      const { get } = await contentOf(t, id(1));
      const store = t.platform.content;
      t.platform.content = {
        ...store,
        async get() {
          throw new Error("EIO");
        },
      };

      expect((await get("page")).status).toBe(500);
      expect(await t.platform.db.select().from(pageContents).all()).toEqual([]);
      t.platform.content = store;
      expect((await get("page")).status).toBe(200);
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

  it("取得中に接続を解除したら、記事の行を入れず、置いた本文は書き留めから片付けられる", async () => {
    const t = await subscribed();
    t.remote.setMessages({ [id(1)]: { content: "テキスト" } });
    t.remote.beforeMessages(() => disconnectDiscord(t.platform.db, t.user.id));
    const before = new Set(
      (await t.platform.db.select().from(contentNotes).all()).map(({ key }) => key),
    );

    expect(await runFetchFeed(t.platform, t.feedId)).toEqual({ status: "missing" });

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
