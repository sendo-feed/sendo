import { expect, it, onTestFinished, vi } from "vitest";
import { getDiscordMessages } from "../../../src/discord/client";
import { createNodePlatform } from "../../../src/platform/node";
import { createDiscordBotFetch } from "../../../src/platform/node/discord-rest";
import { createSqliteJobQueue } from "../../../src/platform/node/job-queue";
import { testDatabase } from "../../db";
import { fakeFetch, unusedNative, unusedSyncUpdates } from "../../helpers";

const API = "https://discord.com/api/v10";
const TOKEN = "test-bot-token";
const bot = { headers: { authorization: `Bot ${TOKEN}` } };

it.each(["relative", "absolute"])(
  "同じ枠を %s の期限まで止め、別のサーバーは取得できる",
  async (form) => {
    let time = 10_000;
    const lastInBucket = Promise.withResolvers<Response>();
    const upstream = fakeFetch((url) => {
      if (url.pathname === "/api/v10/guilds/201/members/501") return lastInBucket.promise;
      return Response.json({}, { headers: { "x-ratelimit-bucket": "guild-bucket" } });
    });
    const fetch = createDiscordBotFetch(upstream.fetch, TOKEN, () => time);
    await fetch(`${API}/guilds/201`, bot);

    const reading = fetch(`${API}/guilds/201/members/501`, bot);
    await vi.waitFor(() => expect(upstream.calls).toHaveLength(2));
    const blocked = expect(fetch(`${API}/guilds/201`, bot)).rejects.toMatchObject({
      code: "rate_limited",
      retryAfterMs: 250,
    });
    const independent = fetch(`${API}/guilds/202`, bot);
    expect(upstream.calls).toHaveLength(2);
    lastInBucket.resolve(
      Response.json(
        {},
        {
          headers: {
            "x-ratelimit-bucket": "guild-bucket",
            "x-ratelimit-remaining": "0",
            ...(form === "relative"
              ? { "x-ratelimit-reset-after": "0.250" }
              : {
                  date: new Date(time).toUTCString(),
                  "x-ratelimit-reset": "10.25",
                }),
          },
        },
      ),
    );
    expect((await reading).status).toBe(200);
    await blocked;
    expect((await independent).status).toBe(200);
    expect(upstream.calls).toHaveLength(3);

    time += 249;
    await expect(fetch(`${API}/guilds/201/members/502`, bot)).rejects.toMatchObject({
      code: "rate_limited",
      retryAfterMs: 1,
    });
    expect(upstream.calls).toHaveLength(3);
    time++;
    expect((await fetch(`${API}/guilds/201/members/502`, bot)).status).toBe(200);
    expect(upstream.calls).toHaveLength(4);
  },
);

it("本文で返った Bot 全体の 429 は別の枠にも適用し、期限後に再開する", async () => {
  let time = 10_000;
  const upstream = fakeFetch((url) =>
    url.pathname.endsWith("/201")
      ? Response.json({ retry_after: 0.5, global: true }, { status: 429 })
      : Response.json({}),
  );
  const fetch = createDiscordBotFetch(upstream.fetch, TOKEN, () => time);
  await expect(fetch(`${API}/guilds/201`, bot)).rejects.toMatchObject({
    code: "rate_limited",
    retryAfterMs: 500,
  });
  await expect(fetch(`${API}/channels/301/messages`, bot)).rejects.toMatchObject({
    code: "rate_limited",
    retryAfterMs: 500,
  });
  expect(upstream.calls).toHaveLength(1);
  expect((await fetch(`${API}/oauth2/token`, { method: "POST" })).status).toBe(200);
  time += 500;
  expect((await fetch(`${API}/channels/301/messages`, bot)).status).toBe(200);
  expect(upstream.calls).toHaveLength(3);
});

it.each([
  {
    headers: new Headers({ "retry-after": "999999999999999" }),
    body: { retry_after: 2 },
    expected: 2_000,
  },
  {
    headers: new Headers({ "x-ratelimit-reset": "1" }),
    body: { retry_after: -0.0001 },
    expected: undefined,
  },
])("429 の無効な待機を除外して有効な値 $expected を返す", async ({ headers, body, expected }) => {
  const upstream = fakeFetch(() => Response.json(body, { status: 429, headers }));
  const fetch = createDiscordBotFetch(upstream.fetch, TOKEN, () => 10_000);
  await expect(fetch(`${API}/guilds/201`, bot)).rejects.toMatchObject({
    code: "rate_limited",
    retryAfterMs: expected,
  });
});

it("429 の本文が壊れてもヘッダーで分かった待機を返す", async () => {
  const upstream = fakeFetch(
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("connection closed after headers"));
          },
        }),
        { status: 429, headers: { "retry-after": "2" } },
      ),
  );
  const fetch = createDiscordBotFetch(upstream.fetch, TOKEN, () => 10_000);
  await expect(fetch(`${API}/guilds/201`, bot)).rejects.toMatchObject({
    code: "rate_limited",
    retryAfterMs: 2_000,
  });
  await expect(fetch(`${API}/guilds/201`, bot)).rejects.toMatchObject({
    code: "rate_limited",
    retryAfterMs: 2_000,
  });
  expect(upstream.calls).toHaveLength(1);
});

it("Node の組み立てで Bot の読み取りに制限を反映し、通信失敗のあとも送信を続ける", async () => {
  const first = Promise.withResolvers<Response>();
  const upstream = fakeFetch((url) => {
    if (url.pathname === "/api/v10/channels/201/messages") return first.promise;
    return Response.json([], {
      headers: {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset-after": "60",
      },
    });
  });
  const platform = createNodePlatform({
    db: testDatabase.db,
    jobs: createSqliteJobQueue(testDatabase.db),
    fetch: upstream.fetch,
    env: {
      DISCORD_CLIENT_ID: "101",
      DISCORD_CLIENT_SECRET: "test-secret",
      DISCORD_BOT_TOKEN: TOKEN,
      READER_URL: "https://reader.example.com",
    },
    ...unusedNative,
    syncUpdates: unusedSyncUpdates,
  });
  const discord = platform.discord;
  if (!discord) throw new Error("Discord is not configured");
  const read = (channel: string) => getDiscordMessages(platform.fetch, discord, channel, "0");
  const timeout = vi.spyOn(AbortSignal, "timeout");
  onTestFinished(() => timeout.mockRestore());
  const before = expect(read("201")).rejects.toMatchObject({ code: "network" });
  const after = read("202");
  await vi.waitFor(() => expect(upstream.calls).toHaveLength(1));
  expect(timeout.mock.calls).toEqual([[10_000]]);
  first.reject(new Error("connection closed"));
  await before;
  expect(await after).toEqual([]);
  expect(timeout.mock.calls).toEqual([[10_000], [10_000]]);
  await expect(read("202")).rejects.toMatchObject({
    code: "rate_limited",
  });
  expect(upstream.calls).toHaveLength(2);
  expect((await platform.fetch("https://example.com/rss")).status).toBe(200);
  expect(upstream.calls).toHaveLength(3);
});
