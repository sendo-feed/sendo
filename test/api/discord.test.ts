import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { connectDiscord, disconnectDiscord, insertDiscordArticles } from "../../src/db/discord";
import { findFeedByUrl, getFeed } from "../../src/db/feeds";
import { articles, feeds } from "../../src/db/schema";
import { createSession } from "../../src/db/sessions";
import { readStorageUsage } from "../../src/db/storage";
import { subscribeMany } from "../../src/db/subscriptions";
import { runFetchFeed } from "../../src/jobs/fetch-feed";
import type { Platform } from "../../src/platform";
import { createTestPlatform, createUser, fakeFetch, requestApp } from "../helpers";

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
  let guildIcon: unknown = null;
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
      return Response.json({
        owner_id: "104",
        icon: guildIcon,
        roles: [{ id: "201", permissions: READ }],
      });
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
    setGuildIcon: (icon: unknown) => {
      guildIcon = icon;
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
          guid: messageIdAt(publishedAt),
          url: `${CHANNEL}/${messageIdAt(publishedAt)}`,
          title: "daily",
          summary: "daily",
          author: "bot",
          publishedAt,
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
