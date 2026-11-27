import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { startDiscordGateway } from "../../../src/platform/node/discord-gateway";
import { fakeDiscordGateway } from "../../fixtures/discord-gateway";

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function start(
  getGatewayInfo = vi.fn(async () => ({
    url: "wss://gateway.discord.gg",
    remaining: 999,
    resetAfterMs: 24 * 60 * 60 * 1_000,
  })),
) {
  const fake = fakeDiscordGateway();
  const onMessage = vi.fn(async () => {});
  const onReady = vi.fn(async () => {});
  const gateway = startDiscordGateway({
    token: "test-token",
    getGatewayInfo,
    onMessage,
    onReady,
    connect: fake.connect,
  });
  onTestFinished(() => gateway.stop());
  await vi.advanceTimersByTimeAsync(0);
  return { fake, gateway, onMessage, onReady };
}

it("接続中の投稿を知らせ、切断後に再開して再送された投稿も知らせる", async () => {
  const { fake, onMessage, onReady } = await start();
  const first = fake.socket();
  first.hello();
  expect(first.sent[0]).toMatchObject({ op: 2, d: { token: "test-token", intents: 512 } });
  expect(fake.options[0]).toMatchObject({
    lookup: expect.any(Function),
    followRedirects: false,
  });
  first.ready();
  first.receive(0, { guild_id: "201", channel_id: "301" }, { s: 2, t: "MESSAGE_CREATE" });
  expect(onReady).toHaveBeenCalledOnce();
  expect(onMessage).toHaveBeenLastCalledWith({ guildId: "201", channelId: "301" });

  first.receive(7, null);
  await vi.advanceTimersByTimeAsync(1_000);
  const second = fake.socket(1);
  expect(fake.urls[1]).toBe("wss://gateway-us-east1-b.discord.gg/?v=10&encoding=json");
  second.hello();
  expect(second.sent).toEqual([
    { op: 6, d: { token: "test-token", session_id: "session", seq: 2 } },
  ]);
  second.receive(0, { guild_id: "201", channel_id: "302" }, { s: 3, t: "MESSAGE_CREATE" });
  second.receive(0, null, { s: 4, t: "RESUMED" });
  expect(onReady).toHaveBeenCalledOnce();
  expect(onMessage.mock.calls).toEqual([
    [{ guildId: "201", channelId: "301" }],
    [{ guildId: "201", channelId: "302" }],
  ]);
});

it("再開先を Discord に限定し、セッションを再開できなければ取得し直す", async () => {
  const { fake, gateway, onReady } = await start();
  fake.socket().hello();
  fake.socket().ready(1, "wss://gateway.discord.gg.evil.example/");
  fake.socket().terminate();
  await vi.advanceTimersByTimeAsync(1_000);
  const second = fake.socket(1);
  expect(fake.urls[1]).toBe("wss://gateway.discord.gg/?v=10&encoding=json");
  second.hello();
  expect(second.sent[0]).toMatchObject({ op: 6 });
  second.receive(9, false);
  await vi.advanceTimersByTimeAsync(3_999);
  expect(fake.urls).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(1);
  const third = fake.socket(2);
  third.hello();
  expect(third.sent[0]).toMatchObject({ op: 2 });
  third.ready();
  expect(onReady).toHaveBeenCalledTimes(2);

  gateway.stop();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(fake.urls).toHaveLength(3);
});

it("Heartbeat の応答が来なければつなぎ直す", async () => {
  const { fake } = await start();
  const first = fake.socket();
  first.hello(2_000);
  first.ready();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(first.sent.at(-1)).toEqual({ op: 1, d: 1 });
  first.receive(11, undefined);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(first.closed).toBe(false);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(first.closed).toBe(true);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(fake.urls).toHaveLength(2);
});

it("再開先に接続できないときは既定の Gateway でセッションを作り直す", async () => {
  const { fake, onReady } = await start();
  fake.socket().hello();
  fake.socket().ready();
  fake.socket().terminate();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(fake.urls[1]).toContain("gateway-us-east1-b.discord.gg");
  fake.socket(1).terminate();
  await vi.advanceTimersByTimeAsync(4_000);
  expect(fake.urls[2]).toContain("gateway.discord.gg");
  fake.socket(2).hello();
  expect(fake.socket(2).sent[0]).toMatchObject({ op: 2 });
  fake.socket(2).ready();
  expect(onReady).toHaveBeenCalledTimes(2);
});

it("Bot に新しいセッションの残りがなければ Discord のリセットを待つ", async () => {
  const getGatewayInfo = vi.fn(async () => ({
    url: "wss://gateway.discord.gg",
    remaining: 999,
    resetAfterMs: 50_000,
  }));
  getGatewayInfo.mockResolvedValueOnce({
    url: "wss://gateway.discord.gg",
    remaining: 1,
    resetAfterMs: 50_000,
  });
  const { fake } = await start(getGatewayInfo);
  expect(fake.urls).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(49_999);
  expect(getGatewayInfo).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(getGatewayInfo).toHaveBeenCalledTimes(2);
  expect(fake.urls).toEqual(["wss://gateway.discord.gg/?v=10&encoding=json"]);
});
