import { once } from "node:events";
import { request } from "node:http";
import { connect as connectTcp } from "node:net";
import { afterEach, beforeEach, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createApp } from "../../../src/app";
import { insertFeed } from "../../../src/db/feeds";
import { users } from "../../../src/db/schema";
import { createSession } from "../../../src/db/sessions";
import { subscribeMany } from "../../../src/db/subscriptions";
import { runJob } from "../../../src/jobs";
import type { Platform } from "../../../src/platform";
import { createNodePlatform, withPublicOrigin } from "../../../src/platform/node";
import { createSqliteJobQueue, type SqliteJobQueue } from "../../../src/platform/node/job-queue";
import { createNodeServer } from "../../../src/platform/node/server";
import { createNodeSyncUpdates } from "../../../src/platform/node/sync-updates";
import { openTestDatabase } from "../../db";
import { unusedNative } from "../../helpers";

const ORIGIN = "https://reader.example";
const UPDATES = "/api/v1/sync/updates";
const FEED_URL = "https://news.example.com/feed.xml";
const RSS = `<rss version="2.0"><channel><title>Blog</title>
  <item><title>First</title><guid>1</guid></item>
  <item><title>Second</title><guid>2</guid></item>
</channel></rss>`;

let database: Awaited<ReturnType<typeof openTestDatabase>>;
let platform: Platform;
let jobs: SqliteJobQueue;
let hub: ReturnType<typeof createNodeSyncUpdates>;
let server: ReturnType<typeof createNodeServer>;
let httpUrl: string;

beforeEach(async () => {
  database = await openTestDatabase();
  hub = createNodeSyncUpdates(database.db, { heartbeatIntervalMs: 200, coalesceMs: 100 });
  jobs = createSqliteJobQueue(database.db);
  platform = createNodePlatform({
    env: { DATA_DIR: database.directory },
    db: database.db,
    jobs,
    syncUpdates: hub.updates,
    ...unusedNative,
    fetch: async (input) =>
      String(input) === FEED_URL ? new Response(RSS) : new Response(null, { status: 404 }),
  });
  const app = createApp(platform);
  server = createNodeServer(withPublicOrigin(app.fetch, ORIGIN), hub.webSocketServer, "127.0.0.1");
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing HTTP address");
  httpUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await hub.stop();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await database.cleanup();
});

async function session(userId = crypto.randomUUID()) {
  const now = new Date();
  await database.db
    .insert(users)
    .values({ id: userId, email: `${userId}@example.com`, createdAt: now })
    .onConflictDoNothing()
    .run();
  const { token } = await createSession(database.db, { userId, now });
  return { userId, cookie: `__Host-sendo_session=${token}` };
}

const connect = (headers: Record<string, string>, autoPong = true) =>
  new WebSocket(`${httpUrl.replace("http:", "ws:")}${UPDATES}`, { headers, autoPong });

async function openSocket(cookie: string) {
  const socket = connect({ cookie, origin: ORIGIN });
  await once(socket, "open");
  return socket;
}

function rejectSocket(headers: Record<string, string>) {
  const socket = connect(headers);
  return new Promise<number | undefined>((resolve, reject) => {
    socket.on("error", reject);
    socket.once("open", () => {
      socket.terminate();
      reject(new Error("unexpected WebSocket connection"));
    });
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      if (response.headers["content-length"] !== "0") {
        reject(new Error("upgrade rejection should have no body"));
      } else {
        resolve(response.statusCode);
      }
    });
  });
}

function nextMessage(socket: WebSocket) {
  return new Promise<string>((resolve, reject) => {
    socket.once("error", reject);
    socket.once("message", (data) => resolve(data.toString()));
  });
}

it("PUBLIC_URL と同じオリジンの、有効なブラウザセッションを受ける", async () => {
  const { cookie } = await session();
  expect(await rejectSocket({ origin: "https://another.example", cookie })).toBe(403);
  expect(await rejectSocket({ cookie })).toBe(403);
  expect(await rejectSocket({ origin: ORIGIN })).toBe(401);
  expect(await rejectSocket({ origin: ORIGIN, cookie: "__Host-sendo_session=invalid" })).toBe(401);
  const plain = await fetch(`${httpUrl}${UPDATES}`, { headers: { cookie, origin: ORIGIN } });
  expect(plain.status).toBe(400);

  const socket = await openSocket(cookie);
  const closed = once(socket, "close");
  await hub.stop();
  const [code, reason] = await closed;
  expect(code).toBe(1001);
  expect(String(reason)).toBe("going away");
});

it("短いあいだの知らせを利用者ごとにまとめて、1 回だけ送る", async () => {
  const reader = await session();
  const other = await session();
  const socket = await openSocket(reader.cookie);
  const otherSocket = await openSocket(other.cookie);
  const messages: string[] = [];
  socket.on("message", (data) => messages.push(data.toString()));
  const otherMessages: string[] = [];
  otherSocket.on("message", (data) => otherMessages.push(data.toString()));

  await hub.updates.notify([reader.userId]);
  await hub.updates.notify([reader.userId, other.userId]);
  await hub.updates.notify([reader.userId]);
  await expect.poll(() => messages.length + otherMessages.length).toBe(2);
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(messages).toEqual([JSON.stringify({ type: "sync_required" })]);
  expect(otherMessages).toEqual([JSON.stringify({ type: "sync_required" })]);

  // まとめる長さが過ぎたあとの知らせは、また送る
  await hub.updates.notify([reader.userId]);
  await expect.poll(() => messages.length).toBe(2);
  socket.close();
  otherSocket.close();
});

it("止めるとき、閉じる手続きに応えない接続も、待ってから切る", async () => {
  const quick = createNodeSyncUpdates(database.db, { closeTimeoutMs: 100 });
  const quickServer = createNodeServer(
    withPublicOrigin(createApp({ ...platform, syncUpdates: quick.updates }).fetch, ORIGIN),
    quick.webSocketServer,
    "127.0.0.1",
  );
  quickServer.listen(0, "127.0.0.1");
  await once(quickServer, "listening");
  const address = quickServer.address();
  if (!address || typeof address === "string") throw new Error("missing HTTP address");
  try {
    const { cookie } = await session();
    // ハンドシェイクだけをして、届いたフレームには応えないクライアント
    const raw = connectTcp(address.port, "127.0.0.1");
    await once(raw, "connect");
    const received: Buffer[] = [];
    raw.on("data", (chunk: Buffer) => received.push(chunk));
    raw.write(
      [
        `GET ${UPDATES} HTTP/1.1`,
        `Host: 127.0.0.1:${address.port}`,
        "Connection: Upgrade",
        "Upgrade: websocket",
        "Sec-WebSocket-Version: 13",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        `Origin: ${ORIGIN}`,
        `Cookie: ${cookie}`,
        "",
        "",
      ].join("\r\n"),
    );
    await expect.poll(() => Buffer.concat(received).toString("latin1")).toContain(" 101 ");
    const ended = once(raw, "close");
    await quick.stop();
    await ended;
    const bytes = Buffer.concat(received);
    const frame = bytes.subarray(bytes.indexOf("\r\n\r\n") + 4);
    // 閉じるフレーム（0x88）と、コード 1001
    expect(frame[0]).toBe(0x88);
    expect(frame.readUInt16BE(2)).toBe(1001);
  } finally {
    await new Promise<void>((resolve) => quickServer.close(() => resolve()));
  }
});

it("取得ジョブと既読・スターの更新を本人の接続に送り、ログアウト済みの接続を閉じる", async () => {
  const reader = await session();
  const secondReader = await session(reader.userId);
  const other = await session();
  const now = new Date();
  const { feed } = await insertFeed(database.db, { id: crypto.randomUUID(), url: FEED_URL, now });
  await subscribeMany(database.db, {
    userId: reader.userId,
    rows: [{ feedId: feed.id, folderId: null }],
    now,
  });
  const first = await openSocket(reader.cookie);
  const second = await openSocket(secondReader.cookie);
  const unrelated = await openSocket(other.cookie);
  const unrelatedMessages: string[] = [];
  unrelated.on("message", (data) => unrelatedMessages.push(data.toString()));

  const sync = async (cursor?: string) => {
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    const response = await fetch(`${httpUrl}/api/v1/sync${query}`, {
      headers: { cookie: reader.cookie },
    });
    expect(response.status).toBe(200);
    return (await response.json()) as {
      cursor: string;
      articles: { id: string; readAt: string | null; starredAt: string | null }[];
    };
  };

  const initial = await sync();
  const arrivals = Promise.all([nextMessage(first), nextMessage(second)]);
  await jobs.enqueue([{ type: "fetch-feed", feedId: feed.id }]);
  expect(await jobs.runDue((job) => runJob(platform, job))).toBe(1);
  const hint = '{"type":"sync_required"}';
  expect(await arrivals).toEqual([hint, hint]);
  const changed = await sync(initial.cursor);
  expect(changed.articles).toHaveLength(2);
  const article = changed.articles[0];
  if (!article) throw new Error("missing article");

  const updated = nextMessage(second);
  const response = await fetch(`${httpUrl}/api/v1/articles/${article.id}`, {
    method: "PATCH",
    headers: { origin: ORIGIN, cookie: reader.cookie, "content-type": "application/json" },
    body: JSON.stringify({ read: true, starred: true }),
  });
  expect(response.status).toBe(200);
  expect(await updated).toBe(hint);
  expect((await sync(changed.cursor)).articles).toEqual([
    expect.objectContaining({
      id: article.id,
      readAt: expect.any(String),
      starredAt: expect.any(String),
    }),
  ]);

  const closed = once(unrelated, "close");
  const logout = await fetch(`${httpUrl}/api/v1/auth/logout`, {
    method: "POST",
    headers: { origin: ORIGIN, cookie: other.cookie },
  });
  expect(logout.status).toBe(204);
  await hub.updates.notify([other.userId]);
  expect((await closed)[0]).toBe(1008);
  expect(unrelatedMessages).toEqual([]);
});

it("ベルを付けると本人の接続に知らせ、次の同期でそのベルが届く", async () => {
  const reader = await session();
  const other = await session();
  const now = new Date();
  const { feed } = await insertFeed(database.db, { id: crypto.randomUUID(), url: FEED_URL, now });
  await subscribeMany(database.db, {
    userId: reader.userId,
    rows: [{ feedId: feed.id, folderId: null }],
    now,
  });
  const socket = await openSocket(reader.cookie);
  const unrelated = await openSocket(other.cookie);
  const unrelatedMessages: string[] = [];
  unrelated.on("message", (data) => unrelatedMessages.push(data.toString()));
  const sync = async (cursor?: string) => {
    const query = new URLSearchParams({ includeBells: "true", ...(cursor && { cursor }) });
    const response = await fetch(`${httpUrl}/api/v1/sync?${query}`, {
      headers: { cookie: reader.cookie },
    });
    expect(response.status).toBe(200);
    return (await response.json()) as { cursor: string; bells: { id: string }[] };
  };
  const initial = await sync();

  const arrival = nextMessage(socket);
  const response = await fetch(`${httpUrl}/api/v1/bells`, {
    method: "POST",
    headers: { origin: ORIGIN, cookie: reader.cookie, "content-type": "application/json" },
    body: JSON.stringify({ feedId: feed.id }),
  });
  expect(response.status).toBe(201);
  const { bell } = (await response.json()) as { bell: { id: string } };
  expect(await arrival).toBe('{"type":"sync_required"}');
  expect((await sync(initial.cursor)).bells).toEqual([
    expect.objectContaining({ id: bell.id, feedId: feed.id, deleted: false }),
  ]);
  expect(unrelatedMessages).toEqual([]);
});

it("通知の失敗後も新着を差分で読めて、同じ記事の再取得では通知しない", async () => {
  const reader = await session();
  const now = new Date();
  const { feed } = await insertFeed(database.db, { id: crypto.randomUUID(), url: FEED_URL, now });
  await subscribeMany(database.db, {
    userId: reader.userId,
    rows: [{ feedId: feed.id, folderId: null }],
    now,
  });

  const notifications: string[][] = [];
  hub.updates.notify = async (userIds) => {
    notifications.push([...userIds]);
    throw new Error("notifications unavailable");
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    await runJob(platform, { type: "fetch-feed", feedId: feed.id });
  }
  expect(notifications).toEqual([[reader.userId]]);
  const response = await fetch(`${httpUrl}/api/v1/sync`, { headers: { cookie: reader.cookie } });
  expect(await response.json()).toMatchObject({
    articles: [expect.any(Object), expect.any(Object)],
  });
});

it.each([
  ["GET", "/healthz", "h2c", 200],
  ["GET", "/healthz", "websocket", 200],
  ["POST", UPDATES, "websocket", 401],
])(
  "通知以外の Upgrade を通常の HTTP で扱う（%s %s %s）",
  async (method, route, upgrade, status) => {
    const result = new Promise<number | undefined>((resolve, reject) => {
      const outgoing = request(`${httpUrl}${route}`, {
        method,
        headers: { connection: "Upgrade", upgrade },
      });
      outgoing.once("error", reject);
      outgoing.once("response", (response) => {
        response.resume();
        resolve(response.statusCode);
      });
      outgoing.once("upgrade", (_response, socket) => {
        socket.destroy();
        reject(new Error("unexpected protocol upgrade"));
      });
      outgoing.end();
    });
    expect(await result).toBe(status);
  },
);

it.each(["GET", "HEAD"])(
  "%s が通常の HTTP になった場合は Upgrade せずに 400 を返す",
  async (method) => {
    const { cookie } = await session();
    const result = new Promise<number | undefined>((resolve, reject) => {
      const outgoing = request(`${httpUrl}${UPDATES}`, {
        method,
        headers: {
          origin: ORIGIN,
          cookie,
          upgrade: "websocket",
          ...(method === "HEAD" && { connection: "Upgrade" }),
        },
      });
      outgoing.once("error", reject);
      outgoing.once("response", (response) => {
        response.resume();
        resolve(response.statusCode);
      });
      outgoing.end();
    });
    expect(await result).toBe(400);
  },
);

it("更新通知がなくてもログアウト済みの接続を回収する", async () => {
  const { cookie } = await session();
  const socket = await openSocket(cookie);
  const closed = once(socket, "close");
  const logout = await fetch(`${httpUrl}/api/v1/auth/logout`, {
    method: "POST",
    headers: { origin: ORIGIN, cookie },
  });
  expect(logout.status).toBe(204);
  expect((await closed)[0]).toBe(1008);
});

it("ping に応答しない接続を閉じ、ほかの接続は保つ", async () => {
  const { cookie } = await session();
  const responsive = await openSocket(cookie);
  const unresponsive = connect({ cookie, origin: ORIGIN }, false);
  await once(unresponsive, "open");
  await once(unresponsive, "close");
  expect(responsive.readyState).toBe(WebSocket.OPEN);
});

it("公開オリジンの設定が不正な場合は通知の接続を拒否する", async () => {
  const invalid = createNodeSyncUpdates(database.db, { invalidPublicOrigin: true });
  try {
    platform.syncUpdates = invalid.updates;
    const { cookie } = await session();
    expect(await rejectSocket({ cookie, origin: ORIGIN })).toBe(403);
    expect((await fetch(`${httpUrl}/healthz`)).status).toBe(200);
  } finally {
    await invalid.stop();
  }
});

it("形式が不正なハンドシェイクには 400 と説明を返す", async () => {
  const { cookie } = await session();
  const result = await new Promise<{ status: number | undefined; type: string | undefined }>(
    (resolve, reject) => {
      const outgoing = request(`${httpUrl}${UPDATES}`, {
        headers: {
          origin: ORIGIN,
          cookie,
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-version": "13",
        },
      });
      outgoing.once("error", reject);
      outgoing.once("response", (response) => {
        response.resume();
        resolve({
          status: response.statusCode,
          type: response.headers["content-type"],
        });
      });
      outgoing.end();
    },
  );
  expect(result).toEqual({ status: 400, type: "text/html" });
});
