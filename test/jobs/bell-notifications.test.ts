import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSession, SESSION_TTL_MS } from "../../src/db/sessions";
import { runJob } from "../../src/jobs";
import { runCleanUp } from "../../src/jobs/clean-up";
import type { Job } from "../../src/jobs/job";
import { createSqliteJobQueue } from "../../src/platform/node/job-queue";
import { createSafeFetch, type Resolver } from "../../src/platform/node/safe-fetch";
import { testDb } from "../db";
import { clockedDatabase, createTestPlatform, createUser, fakeFetch, requestApp } from "../helpers";
import { createDevice, createPushService, type Device, type PushService } from "../push-service";

/*
 * ベルの記事を Web Push で送る（docs/decisions/notifications.md の 8〜16、web-push.md の 5、6）。
 *
 * 購読、ベル、端末の登録は REST API で作り、記事は取得の仕事で取り込む。送る仕事は仕事の表
 * （本番と同じ SQLite の表）から動かす。プッシュサービスは偽物で、受けた本体を端末の秘密鍵で
 * 復号して中身を確かめる。DB の時計は止めて、テストが進める。
 */

const SUBJECT = "mailto:admin@example.com";
const READER = "https://reader.example.com";
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** 通知に関わる仕事。ほかの仕事（言語の判定など）は、動かさずに消す */
const NOTIFICATION_JOBS = new Set<Job["type"]>([
  "fetch-feed",
  "send-bell-notification",
  "bundle-bell-notifications",
]);

type Item = { guid: string; title: string; publishedAt: Date | null };

const escapeXml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

function rss(items: readonly Item[]) {
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>Blog</title>
    <link>https://blog.example/</link>${items
      .map(
        (item) =>
          `<item><title>${escapeXml(item.title)}</title><guid isPermaLink="false">${item.guid}</guid>${
            item.publishedAt ? `<pubDate>${item.publishedAt.toUTCString()}</pubDate>` : ""
          }</item>`,
      )
      .join("")}</channel></rss>`;
}

beforeEach(async () => {
  // 仕事の表はテストファイルの中で共有される。前のテストのやり直し待ちの仕事を動かさない
  await testDb.prepare("DELETE FROM job_queue").run();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * 時計、フィードの配信元、プッシュサービス、仕事の表をそろえる。
 *
 * @param options.resolve 渡すと、プッシュサービスへの送信は、この名前解決で接続する IP を確かめる
 *   緩衝層の fetch（platform/node/safe-fetch.ts）を通す
 * @param options.processLagMs プロセスの時計を、DB の時計からこれだけ遅らせる
 */
function createWorld(options: { resolve?: Resolver; processLagMs?: number } = {}) {
  // 秒の区切りに合わせる（RSS の日付は秒まで）
  const clock = { ms: Math.floor(Date.now() / SECOND) * SECOND };
  let hook: { match: RegExp; run: () => Promise<void> } | undefined;
  const db = clockedDatabase(clock, async (sql) => {
    const current = hook;
    if (current?.match.test(sql)) {
      hook = undefined;
      await current.run();
    }
  });
  const now = () => new Date(clock.ms - (options.processLagMs ?? 0));
  const service = createPushService();
  const sources = new Map<string, Item[]>();
  const fake = fakeFetch((url, init) => {
    const items = sources.get(url.host);
    return items ? new Response(rss(items)) : service.receive(url, init);
  });
  const safeFetch = options.resolve ? createSafeFetch(options.resolve) : undefined;
  const fetch: typeof globalThis.fetch = (input, init) =>
    safeFetch && !sources.has(new URL(String(input)).host)
      ? safeFetch(input, init)
      : fake.fetch(input, init);
  const jobs = createSqliteJobQueue(db, { now });
  const { platform } = createTestPlatform({
    db,
    jobs,
    fetch,
    now,
    push: { subject: SUBJECT, readerOrigin: READER },
  });
  const run = (job: Job) =>
    NOTIFICATION_JOBS.has(job.type) ? runJob(platform, job) : Promise.resolve();

  /** 時期の来た仕事を、なくなるまで動かす */
  const drain = async () => {
    for (let round = 0; round < 50; round++) {
      if ((await jobs.runDue(run, 10)) === 0) return;
    }
    throw new Error("jobs kept coming");
  };

  return {
    clock,
    platform,
    service,
    drain,
    advance(ms: number) {
      clock.ms += ms;
    },
    /** match に当たる文を実行する直前に、一度だけ run を動かす */
    before(match: RegExp, run: () => Promise<void>) {
      hook = { match, run };
    },
    /** 配信元のフィードを作る */
    source(items: Item[] = []) {
      const host = `${crypto.randomUUID()}.example.com`;
      sources.set(host, items);
      return { url: `https://${host}/feed.xml`, items };
    },
    /** 取得の仕事を積んで、送る仕事まで動かす（定期実行が積むのと同じ仕事） */
    async fetchFeed(feedId: string) {
      await jobs.enqueue([{ type: "fetch-feed", feedId }]);
      await drain();
    },
    /** 今の時刻から ago だけ前に出た記事 */
    item(title: string, ago = MINUTE): Item {
      return { guid: crypto.randomUUID(), title, publishedAt: new Date(clock.ms - ago) };
    },
  };
}

type World = ReturnType<typeof createWorld>;

/** REST API で操作する利用者 */
async function createReader(world: World) {
  const { id, token } = await createUser();
  const { platform } = world;
  const api = (path: string, method = "GET", json?: unknown) =>
    requestApp(platform, `/api/v1${path}`, { method, json, token });
  const putRegistration = async (headers: Record<string, string>, key: Device, host?: string) => {
    const endpoint = world.service.endpoint(key, host);
    const res = await requestApp(platform, "/api/v1/push/registration", {
      method: "PUT",
      token: null,
      headers,
      json: { endpoint, expirationTime: null, keys: key.keys },
    });
    expect(res.status).toBe(204);
    return { endpoint };
  };

  return {
    id,
    api,
    async subscribe(source: { url: string }) {
      const res = await api("/feeds", "POST", { url: source.url });
      expect(res.status).toBe(201);
      return ((await res.json()) as { feed: { id: string } }).feed.id;
    },
    async bell(feedId: string) {
      const res = await api("/bells", "POST", { feedId });
      expect(res.status).toBe(201);
      return ((await res.json()) as { bell: { id: string } }).bell.id;
    },
    /** 新しいブラウザのセッションで、端末を登録する */
    async register(device?: Device, host?: string) {
      const { token: session } = await createSession(platform.db, {
        userId: id,
        now: platform.now(),
      });
      const headers = {
        cookie: `__Host-sendo_session=${session}`,
        "sec-fetch-site": "same-origin",
      };
      const key = device ?? (await createDevice());
      return { ...(await putRegistration(headers, key, host)), headers, device: key };
    },
    /** そのセッションで、新しいエンドポイントの登録を送る（ブラウザが登録し直したとき） */
    async reregister(headers: Record<string, string>) {
      return putRegistration(headers, await createDevice());
    },
    /** この人の端末の登録のエンドポイント。ほかのテストの行は数えない */
    async registeredEndpoints() {
      const rows = await testDb
        .prepare("SELECT endpoint FROM push_registrations WHERE user_id = ?")
        .bind(id)
        .all<{ endpoint: string }>();
      return rows.results.map((row) => row.endpoint);
    },
    async articleId(title: string) {
      const res = await api("/articles?limit=100");
      const { items } = (await res.json()) as { items: { id: string; title: string | null }[] };
      const found = items.find((item) => item.title === title);
      if (!found) throw new Error(`not in the inbox: ${title}`);
      return found.id;
    },
    async unreadTotal() {
      return ((await (await api("/unread-counts")).json()) as { total: number }).total;
    },
  };
}

type Reader = Awaited<ReturnType<typeof createReader>>;

/**
 * フィードを購読して初回の取得を終え、ベルを付けて、端末を 1 つ登録した利用者。初回の取得で
 * 入った記事（前からある記事）は、ベルを付ける前の記事になる
 */
async function belledReader(world: World, reader?: Reader) {
  const user = reader ?? (await createReader(world));
  const source = world.source([world.item("前からある記事", HOUR)]);
  const feedId = await user.subscribe(source);
  world.advance(SECOND);
  await world.drain();
  world.advance(SECOND);
  const bellId = await user.bell(feedId);
  const device = await user.register();
  world.advance(SECOND);
  return { user, source, feedId, bellId, ...device };
}

/** ベルを付けたフィードを、必要な数だけ用意する（1 つのベルは、1 つの窓で 3 通まで） */
async function feedsOf(world: World, user: Reader, count: number) {
  const feeds = [];
  for (let i = 0; i < count; i++) {
    const source = world.source();
    const feedId = await user.subscribe(source);
    await world.drain();
    world.advance(SECOND);
    await user.bell(feedId);
    feeds.push({ source, feedId });
  }
  world.advance(SECOND);
  return feeds;
}

/** feeds に順に 3 件ずつ記事を出し、合わせて total 件を取り込む */
async function publish(
  world: World,
  feeds: { source: { items: Item[] }; feedId: string }[],
  total: number,
) {
  let left = total;
  for (const { source, feedId } of feeds) {
    const count = Math.min(3, left);
    if (count === 0) return;
    for (let i = 0; i < count; i++)
      source.items.push(world.item(`${feedId}-${source.items.length}`));
    await world.fetchFeed(feedId);
    left -= count;
  }
}

const titles = (service: PushService, endpoint?: string) =>
  service.delivered(endpoint).map((request) => request.payload.notification.body);

describe("ベルの記事を送る", () => {
  it("ベルを付けた購読に新しい記事が入ると、端末に 1 通届き、復号するとフィード名、タイトル、記事の ID がある", async () => {
    const world = createWorld();
    const { user, source, feedId, bellId, endpoint } = await belledReader(world);
    source.items.push(world.item("新しい記事"));

    await world.fetchFeed(feedId);

    const articleId = await user.articleId("新しい記事");
    expect(world.service.requests).toHaveLength(1);
    expect(world.service.requests[0]).toMatchObject({
      endpoint,
      status: 201,
      payload: {
        web_push: 8030,
        notification: {
          title: "Blog",
          body: "新しい記事",
          navigate: `${READER}/?article=${articleId}`,
          tag: `bell:${bellId}:${articleId}`,
          data: { bellId, articleId, count: 1 },
        },
        app_badge: await user.unreadTotal(),
        mutable: true,
      },
    });
    expect(world.service.requests[0]?.payload.app_badge).toBe(2);
  });

  it("送る要求は aes128gcm、TTL 12 時間、Urgency high で、VAPID は送り先のオリジンと設定の sub の JWT と、sendo の公開鍵を持つ", async () => {
    const world = createWorld();
    const { source, feedId, endpoint } = await belledReader(world);
    source.items.push(world.item("新しい記事"));

    await world.fetchFeed(feedId);

    const [request] = world.service.requests;
    const status = await requestApp(world.platform, "/api/v1/push");
    const { publicKey } = (await status.json()) as { publicKey: string };
    expect(request?.headers.get("content-encoding")).toBe("aes128gcm");
    expect(request?.headers.get("ttl")).toBe("43200");
    expect(request?.headers.get("urgency")).toBe("high");
    expect(request?.headers.has("topic")).toBe(false);
    expect(request?.redirect).toBe("manual");
    expect(request?.vapid.publicKey).toBe(publicKey);
    expect(request?.vapid.claims).toEqual({
      aud: new URL(endpoint).origin,
      exp: Math.floor((world.clock.ms + 12 * HOUR) / SECOND),
      sub: SUBJECT,
    });
  });

  it("同じ人が端末を 2 つ登録していれば、両方に届く", async () => {
    const world = createWorld();
    const { user, source, feedId, endpoint } = await belledReader(world);
    const second = await user.register();
    source.items.push(world.item("新しい記事"));

    await world.fetchFeed(feedId);

    expect(titles(world.service, endpoint)).toEqual(["新しい記事"]);
    expect(titles(world.service, second.endpoint)).toEqual(["新しい記事"]);
  });

  it("ベルのない購読の新しい記事は送らない。ほかの人がベルを付けていても、その人にだけ届く", async () => {
    const world = createWorld();
    const { source, feedId, endpoint } = await belledReader(world);
    const quiet = await createReader(world);
    expect(await quiet.subscribe(source)).toBe(feedId);
    const quietDevice = await quiet.register();
    // 購読してから 1 度取得に成功したあと（初回の取得ではない）
    await world.fetchFeed(feedId);
    world.advance(SECOND);
    source.items.push(world.item("新しい記事"));

    await world.fetchFeed(feedId);

    expect(titles(world.service, endpoint)).toEqual(["新しい記事"]);
    expect(world.service.requests.filter((r) => r.endpoint === quietDevice.endpoint)).toEqual([]);
  });

  it("ベルを付ける前に取り込んだ記事は送らない。取り込みと判定の間にベルを付けても送らない", async () => {
    const world = createWorld();
    const user = await createReader(world);
    const source = world.source([world.item("前からある記事", HOUR)]);
    const feedId = await user.subscribe(source);
    await world.drain();
    await user.register();
    world.advance(SECOND);
    source.items.push(world.item("取り込んでからベル"));
    // 記事の行を入れたあと、受信箱に配る前に、ベルを付ける
    world.before(/insert into "user_articles"/i, async () => {
      world.advance(SECOND);
      await user.bell(feedId);
    });

    await world.fetchFeed(feedId);
    // 前からある記事は、取得し直しても新しく入らないので、判定しない
    world.advance(SECOND);
    await world.fetchFeed(feedId);

    expect(world.service.requests).toEqual([]);
  });

  it("購読したばかりの初回の取得で入った記事は送らない。新しいフィードでも、ほかの人が取得していたフィードでも", async () => {
    const world = createWorld();
    // ほかの人が購読して取得しているフィード
    const { source: shared, feedId: sharedId, endpoint: firstEndpoint } = await belledReader(world);
    const user = await createReader(world);
    world.advance(SECOND);

    // 購読して、取得が動く前にベルと端末をそろえる
    const fresh = world.source([world.item("新しいフィードの記事")]);
    const freshId = await user.subscribe(fresh);
    expect(await user.subscribe(shared)).toBe(sharedId);
    await user.bell(freshId);
    await user.bell(sharedId);
    const { endpoint } = await user.register();
    shared.items.push(world.item("購読した直後の新着"));
    world.advance(SECOND);
    await world.drain();
    await world.fetchFeed(sharedId);

    expect(titles(world.service, endpoint)).toEqual([]);
    // 前から購読していた人には届く
    expect(titles(world.service, firstEndpoint)).toEqual(["購読した直後の新着"]);

    // 購読してから取得に 1 度成功したあとの記事は届く
    world.advance(SECOND);
    fresh.items.push(world.item("2 回目の取得の記事"));
    shared.items.push(world.item("共有のフィードの 2 回目"));
    await world.fetchFeed(freshId);
    await world.fetchFeed(sharedId);
    expect(titles(world.service, endpoint)).toEqual([
      "2 回目の取得の記事",
      "共有のフィードの 2 回目",
    ]);
  });

  it("公開日時が当たった時刻のちょうど 1 日前の記事は送らず、1 日に 1 秒足りない記事は送る", async () => {
    const world = createWorld();
    const { source, feedId, endpoint } = await belledReader(world);
    source.items.push(
      world.item("ちょうど 1 日前", DAY),
      world.item("1 日に 1 秒足りない", DAY - SECOND),
    );

    await world.fetchFeed(feedId);

    expect(titles(world.service, endpoint)).toEqual(["1 日に 1 秒足りない"]);
  });

  it("公開日時の分からない記事は、取り込んだ時刻を公開日時とみなして送る", async () => {
    // フィードに日付がないと、取得の時刻（プロセスの時計）を公開日時に入れる。プロセスの時計が
    // 遅れていても、取り込んだ時刻（DB の時計）で比べる
    const world = createWorld({ processLagMs: 2 * DAY });
    const { source, feedId, endpoint } = await belledReader(world);
    source.items.push({ guid: crypto.randomUUID(), title: "日付のない記事", publishedAt: null });
    source.items.push(world.item("2 日前の日付の記事", 2 * DAY));

    await world.fetchFeed(feedId);

    expect(titles(world.service, endpoint)).toEqual(["日付のない記事"]);
  });

  it("1 回の取得で判定するのは、公開日時の新しい順に 50 件まで", async () => {
    const world = createWorld();
    const { source, feedId, endpoint } = await belledReader(world);
    // 「記事 0」がいちばん新しく、「記事 50」がいちばん古い
    for (let i = 0; i < 51; i++) source.items.push(world.item(`記事 ${i}`, (i + 1) * MINUTE));
    const opened = world.clock.ms;

    await world.fetchFeed(feedId);
    world.clock.ms = opened + 10 * MINUTE;
    await world.drain();

    // 古い順に行を作るので、1 件ずつ送るのは、選んだ 50 件のうち古い 3 件。いちばん古い
    // 「記事 50」は選ばない。残りの 47 件を 1 通にまとめる
    const delivered = world.service.delivered(endpoint);
    expect(
      delivered
        .slice(0, 3)
        .map((r) => r.payload.notification.body)
        .sort(),
    ).toEqual(["記事 47", "記事 48", "記事 49"]);
    expect(delivered.slice(3).map((r) => r.payload.notification)).toEqual([
      expect.objectContaining({
        body: "記事 0\n記事 1\n記事 2\nほか 44 件",
        data: expect.objectContaining({ count: 47 }),
      }),
    ]);
  });
});

describe("10 分の窓", () => {
  it("同じベルで 10 分のうちに 4 件当たると、3 件は 1 件ずつ送り、4 件目からは 1 件ずつ送らない", async () => {
    const world = createWorld();
    const { source, feedId, endpoint } = await belledReader(world);
    for (const [title, ago] of [
      ["1 件目", 4],
      ["2 件目", 3],
      ["3 件目", 2],
    ] as const) {
      source.items.push(world.item(title, ago * MINUTE));
      await world.fetchFeed(feedId);
      world.advance(3 * MINUTE);
    }
    expect(titles(world.service, endpoint)).toEqual(["1 件目", "2 件目", "3 件目"]);

    // 1 件目から 9 分（窓の中）
    source.items.push(world.item("4 件目"));
    await world.fetchFeed(feedId);

    expect(titles(world.service, endpoint)).toEqual(["1 件目", "2 件目", "3 件目"]);
  });

  it("窓の始まりからちょうど 10 分の記事は新しい窓を開き、1 件ずつ送る。1 ミリ秒前なら同じ窓", async () => {
    const world = createWorld();
    const { source, feedId, endpoint } = await belledReader(world);
    // 1 回の取得で 3 件。どれも同じ時刻に当たり、同じ窓に入る
    source.items.push(world.item("1"), world.item("2"), world.item("3"));
    await world.fetchFeed(feedId);
    const opened = world.clock.ms;

    world.clock.ms = opened + 10 * MINUTE - 1;
    source.items.push(world.item("窓の中"));
    await world.fetchFeed(feedId);
    // 窓の中の 4 件目は、1 件ずつは送らない
    expect(titles(world.service, endpoint).sort()).toEqual(["1", "2", "3"]);
    world.clock.ms = opened + 10 * MINUTE;
    source.items.push(world.item("ちょうど 10 分"));
    await world.fetchFeed(feedId);

    // 窓が閉じたので、窓の中の 4 件目はまとめ（1 件）で届く
    expect(titles(world.service, endpoint).sort()).toEqual(
      ["1", "2", "3", "ちょうど 10 分", "窓の中"].sort(),
    );
  });
});

describe("閉じた窓のまとめ", () => {
  /** 1 回の取得で count 件の記事を入れる。どれも同じ時刻に当たり、同じ窓に入る */
  async function hits(
    world: World,
    feed: { source: { items: Item[] }; feedId: string },
    count: number,
  ) {
    const opened = world.clock.ms;
    for (let i = 0; i < count; i++) {
      // 公開日時の古い順に「記事 1」から
      feed.source.items.push(world.item(`記事 ${i + 1}`, (count - i) * MINUTE));
    }
    await world.fetchFeed(feed.feedId);
    return opened;
  }

  /** そのベルの通知のまとめの行の数 */
  const bundleRows = (bellId: string) =>
    testDb
      .prepare(
        "SELECT count(*) AS n FROM bell_notifications WHERE bell_id = ? AND article_id IS NULL",
      )
      .bind(bellId)
      .first<number>("n");

  /** 仕事の表に積まれている、そのベルのまとめの仕事の数 */
  const bundleJobs = (bellId: string) =>
    testDb
      .prepare(
        `SELECT count(*) AS n FROM job_queue
        WHERE job ->> '$.type' = 'bundle-bell-notifications' AND job ->> '$.bellId' = ?`,
      )
      .bind(bellId)
      .first<number>("n");

  it("窓が閉じたら、4 件目からを 1 通にまとめ、新しい順に 3 件のタイトルと「ほか n 件」を並べ、いちばん新しい記事を開く", async () => {
    const world = createWorld();
    const reader = await belledReader(world);
    const { user, endpoint, bellId } = reader;
    const opened = await hits(world, reader, 7);
    expect(titles(world.service, endpoint).sort()).toEqual(["記事 1", "記事 2", "記事 3"]);

    // 定期実行は動かさない。窓が閉じる時刻を指定して積んだまとめの仕事が動く
    world.clock.ms = opened + 10 * MINUTE;
    await world.drain();

    const newest = await user.articleId("記事 7");
    const bundles = world.service.delivered(endpoint).slice(3);
    expect(bundles.map((r) => r.payload)).toEqual([
      {
        web_push: 8030,
        notification: {
          title: "Blog",
          body: "記事 7\n記事 6\n記事 5\nほか 1 件",
          navigate: `${READER}/?article=${newest}`,
          tag: `bell:${bellId}:${newest}`,
          data: { bellId, articleId: newest, count: 4 },
        },
        app_badge: await user.unreadTotal(),
        mutable: true,
      },
    ]);
  });

  it("窓に 3 件ちょうどなら、まとめの仕事を積まず、まとめを作らない", async () => {
    const world = createWorld();
    const reader = await belledReader(world);
    const opened = await hits(world, reader, 3);
    expect(await bundleJobs(reader.bellId)).toBe(0);

    world.clock.ms = opened + 10 * MINUTE;
    await world.drain();

    expect(titles(world.service, reader.endpoint).sort()).toEqual(["記事 1", "記事 2", "記事 3"]);
  });

  it("まとめの仕事は窓の 4 件目の行を作ったときに 1 つだけ積み、窓が閉じる時刻ちょうどに動く。1 ミリ秒前には動かない", async () => {
    const world = createWorld();
    const reader = await belledReader(world);
    const opened = await hits(world, reader, 4);
    world.clock.ms = opened + MINUTE;
    reader.source.items.push(world.item("記事 5", 2 * MINUTE), world.item("記事 6"));
    await world.fetchFeed(reader.feedId);
    expect(await bundleJobs(reader.bellId)).toBe(1);

    world.clock.ms = opened + 10 * MINUTE - 1;
    await world.drain();
    expect(world.service.delivered(reader.endpoint)).toHaveLength(3);

    world.clock.ms = opened + 10 * MINUTE;
    await world.drain();
    world.advance(5 * MINUTE);
    await world.drain();

    expect(titles(world.service, reader.endpoint).slice(3)).toEqual(["記事 6\n記事 5\n記事 4"]);
    expect(await bundleJobs(reader.bellId)).toBe(0);
  });

  it("同じ窓のまとめの仕事が 2 つ動いても、まとめは 1 通", async () => {
    const world = createWorld();
    const reader = await belledReader(world);
    const opened = await hits(world, reader, 4);
    // 同じ窓の仕事をもう 1 つ積む（窓の最初の bundled の行が片付けで消え、次の bundled の行を作った
    // ときなど）。どちらも窓が閉じる時刻に、並んで動く
    await world.platform.jobs.enqueue(
      [
        {
          type: "bundle-bell-notifications",
          userId: reader.user.id,
          bellId: reader.bellId,
          windowStart: opened,
        },
      ],
      { runAt: new Date(opened + 10 * MINUTE) },
    );

    world.clock.ms = opened + 10 * MINUTE;
    await world.drain();

    expect(titles(world.service, reader.endpoint).slice(3)).toEqual(["記事 4"]);
    expect(await bundleRows(reader.bellId)).toBe(1);
  });

  it("窓が閉じてから 1 時間を過ぎて動いたまとめの仕事は、まとめない。始まりから 70 分ちょうどならまとめず、1 ミリ秒前ならまとめる", async () => {
    const world = createWorld();
    const late = await belledReader(world);
    const onTime = await belledReader(world);
    const lateOpened = await hits(world, late, 4);
    world.clock.ms = lateOpened + 1;
    await hits(world, onTime, 4);

    // プロセスが止まっていて、時刻の来た仕事が遅れて動く。late の窓は始まりから 70 分ちょうど、
    // onTime の窓は 70 分に 1 ミリ秒足りない
    world.clock.ms = lateOpened + 70 * MINUTE;
    await world.drain();

    expect(world.service.delivered(late.endpoint)).toHaveLength(3);
    expect(await bundleRows(late.bellId)).toBe(0);
    expect(titles(world.service, onTime.endpoint).slice(3)).toEqual(["記事 4"]);
  });

  it("窓の 4 件目の行を作ってからまとめの仕事を積む前に落ちたら、その窓のまとめは出ない", async () => {
    const world = createWorld();
    const reader = await belledReader(world);
    const opened = await hits(world, reader, 3);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    // 4 件目は送らないので、行を作ったあとに積むのは、まとめの仕事だけ
    world.before(/insert into "bell_notifications"/i, async () => {
      world.before(/insert into "job_queue"/i, async () => {
        throw new Error("crashed before enqueueing");
      });
    });
    reader.source.items.push(world.item("記事 4"));

    await world.fetchFeed(reader.feedId);
    expect(error).toHaveBeenCalledWith("could not notify bells", expect.anything());
    world.clock.ms = opened + 10 * MINUTE;
    await world.drain();

    expect(world.service.delivered(reader.endpoint)).toHaveLength(3);
    expect(await bundleRows(reader.bellId)).toBe(0);
  });

  it("まとめる前にベルを外したら、まとめない", async () => {
    const world = createWorld();
    const reader = await belledReader(world);
    const opened = await hits(world, reader, 4);
    expect((await reader.user.api(`/bells/${reader.bellId}`, "DELETE")).status).toBe(204);

    world.clock.ms = opened + 10 * MINUTE;
    await world.drain();

    expect(world.service.delivered(reader.endpoint)).toHaveLength(3);
  });

  it("まとめの仕事が行を作る直前にベルを外したら、まとめの行を作らない", async () => {
    const world = createWorld();
    const reader = await belledReader(world);
    const opened = await hits(world, reader, 4);
    world.clock.ms = opened + 10 * MINUTE;
    world.before(/insert into "bell_notifications"/i, async () => {
      expect((await reader.user.api(`/bells/${reader.bellId}`, "DELETE")).status).toBe(204);
    });

    await world.drain();

    expect(world.service.delivered(reader.endpoint)).toHaveLength(3);
    // 送るときにもベルを確かめるが、まとめの行そのものを作らない
    expect(await bundleRows(reader.bellId)).toBe(0);
  });

  it("まとめの行を作る直前に同じベルの記事が当たると、その記事は新しい窓に入って 1 件で届き、まとめには入らない", async () => {
    const world = createWorld();
    const reader = await belledReader(world);
    const opened = await hits(world, reader, 4);
    world.clock.ms = opened + 10 * MINUTE;
    reader.source.items.push(world.item("閉じたあとの記事"));
    world.before(/insert into "bell_notifications"/i, async () => {
      await runJob(world.platform, { type: "fetch-feed", feedId: reader.feedId });
    });

    await world.drain();

    const later = world.service.delivered(reader.endpoint).slice(3);
    expect(
      later.map((r) => [r.payload.notification.body, r.payload.notification.data.count]).sort(),
    ).toEqual([
      ["記事 4", 1],
      ["閉じたあとの記事", 1],
    ]);
  });

  it("上限の 20 通に達していたら、まとめも送らない", async () => {
    const world = createWorld();
    const user = await createReader(world);
    const feeds = await feedsOf(world, user, 7);
    const { endpoint } = await user.register();
    const [bundled, ...others] = feeds;
    if (!bundled) throw new Error("no feed");
    // 1 つ目のフィードは 3 件送って 1 件まとめ待ち、残りで 17 通
    const opened = await hits(world, bundled, 4);
    await publish(world, others, 17);
    expect(world.service.delivered(endpoint)).toHaveLength(20);

    world.clock.ms = opened + 10 * MINUTE;
    await world.drain();

    expect(world.service.delivered(endpoint)).toHaveLength(20);
  });

  it("上限で送らなかった 1〜3 件目は、上限が空いたあとのまとめにも入らない", async () => {
    const world = createWorld();
    const user = await createReader(world);
    const feeds = await feedsOf(world, user, 8);
    const { endpoint } = await user.register();
    const quiet = feeds.at(-1);
    if (!quiet) throw new Error("no feed");
    await publish(world, feeds.slice(0, 7), 20);
    const sentAt = world.clock.ms;

    // 20 通がまだ直近 1 時間にあるうちに、別のベルで 5 件当たる。1〜3 件目は上限で送らない
    world.clock.ms = sentAt + 51 * MINUTE;
    const opened = await hits(world, quiet, 5);
    expect(world.service.delivered(endpoint)).toHaveLength(20);
    // 窓が閉じるときには、20 通は 1 時間より前になっている
    world.clock.ms = opened + 10 * MINUTE;
    await world.drain();

    expect(
      world.service
        .delivered(endpoint)
        .slice(20)
        .map((r) => r.payload.notification),
    ).toEqual([
      expect.objectContaining({
        body: "記事 5\n記事 4",
        data: expect.objectContaining({ count: 2 }),
      }),
    ]);
  });

  it("まとめる前に購読をやめたら、まとめない", async () => {
    const world = createWorld();
    const reader = await belledReader(world);
    const opened = await hits(world, reader, 4);
    expect((await reader.user.api(`/feeds/${reader.feedId}`, "DELETE")).status).toBe(204);

    world.clock.ms = opened + 10 * MINUTE;
    await world.drain();

    expect(world.service.delivered(reader.endpoint)).toHaveLength(3);
  });

  it("まとめ待ちの間に読んだ記事は、まとめにも件数にも入れない。まとめる記事をすべて読んだら、まとめの行も作らない", async () => {
    const world = createWorld();
    const some = await belledReader(world);
    const all = await belledReader(world);
    const opened = await hits(world, some, 6);
    await hits(world, all, 4);
    // ほかの端末で読む
    const read = async (reader: typeof some, title: string) => {
      const id = await reader.user.articleId(title);
      expect((await reader.user.api(`/articles/${id}`, "PATCH", { read: true })).status).toBe(200);
    };
    await read(some, "記事 6");
    await read(all, "記事 4");

    world.clock.ms = opened + 10 * MINUTE;
    await world.drain();

    const newest = await some.user.articleId("記事 5");
    expect(world.service.delivered(some.endpoint).slice(3)).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          notification: expect.objectContaining({
            body: "記事 5\n記事 4",
            navigate: `${READER}/?article=${newest}`,
            data: { bellId: some.bellId, articleId: newest, count: 2 },
          }),
          app_badge: await some.user.unreadTotal(),
        }),
      }),
    ]);
    expect(world.service.delivered(all.endpoint)).toHaveLength(3);
    expect(await bundleRows(all.bellId)).toBe(0);
  });

  it("まとめの行を作ったあと、送る前にまとめる記事をすべて読んだら送らない", async () => {
    const world = createWorld();
    const reader = await belledReader(world);
    const opened = await hits(world, reader, 4);
    world.clock.ms = opened + 10 * MINUTE;
    world.before(/from "bell_notifications" as notification/i, async () => {
      const id = await reader.user.articleId("記事 4");
      expect((await reader.user.api(`/articles/${id}`, "PATCH", { read: true })).status).toBe(200);
    });

    await world.drain();

    expect(await bundleRows(reader.bellId)).toBe(1);
    expect(world.service.delivered(reader.endpoint)).toHaveLength(3);
  });

  it("まとめの行を作ってから送る仕事を積む前に落ちたら、そのまとめは出ず、やり直しても 2 通にならない", async () => {
    const world = createWorld();
    const reader = await belledReader(world);
    const opened = await hits(world, reader, 4);
    world.clock.ms = opened + 10 * MINUTE;
    vi.spyOn(console, "error").mockImplementation(() => {});
    world.before(/insert into "bell_notifications"/i, async () => {
      world.before(/insert into "job_queue"/i, async () => {
        throw new Error("crashed before enqueueing");
      });
    });

    await world.drain();
    // まとめの仕事のやり直し
    world.advance(MINUTE);
    await world.drain();

    expect(world.service.delivered(reader.endpoint)).toHaveLength(3);
    expect(await bundleRows(reader.bellId)).toBe(1);
  });
});

describe("通知の行の片付け", () => {
  it("1 日 1 回の片付けで、作ってから 1 日を過ぎた行を消す。ちょうど 1 日の行は残す", async () => {
    // 行を作った時刻と同じ DB の時計で比べる。プロセスの時計が遅れていても、ずれない
    const world = createWorld({ processLagMs: 2 * DAY });
    const reader = await belledReader(world);
    reader.source.items.push(world.item("新しい記事"));
    await world.fetchFeed(reader.feedId);
    const createdAt = world.clock.ms;
    const rows = () =>
      testDb
        .prepare("SELECT count(*) AS n FROM bell_notifications WHERE bell_id = ?")
        .bind(reader.bellId)
        .first<number>("n");
    expect(await rows()).toBe(1);

    // 消した数には、このファイルのほかのテストの行も入るので、このベルの行で確かめる
    world.clock.ms = createdAt + DAY;
    await runCleanUp(world.platform);
    expect(await rows()).toBe(1);

    world.clock.ms = createdAt + DAY + 1;
    expect((await runCleanUp(world.platform)).bellNotifications).toBeGreaterThanOrEqual(1);
    expect(await rows()).toBe(0);
  });
});

describe("1 時間 20 通", () => {
  it("1 時間に 20 通送ったら、21 通目は送らない。20 通目は送る", async () => {
    const world = createWorld();
    const user = await createReader(world);
    const feeds = await feedsOf(world, user, 8);
    const { endpoint } = await user.register();

    await publish(world, feeds, 20);
    expect(world.service.delivered(endpoint)).toHaveLength(20);

    // 21 通目。このフィードの窓は 2 件目までなので、窓では止まらない
    const last = feeds[6];
    if (!last) throw new Error("no feed");
    last.source.items.push(world.item("21 通目"));
    await world.fetchFeed(last.feedId);

    expect(world.service.delivered(endpoint)).toHaveLength(20);
    expect(titles(world.service, endpoint)).not.toContain("21 通目");
  });

  it("送ってからちょうど 1 時間たつと、また送る。1 ミリ秒前なら送らない", async () => {
    const world = createWorld();
    const user = await createReader(world);
    const feeds = await feedsOf(world, user, 9);
    const { endpoint } = await user.register();
    await publish(world, feeds, 20);
    const sentAt = world.clock.ms;
    const [early, onTime] = feeds.slice(7);
    if (!early || !onTime) throw new Error("no feed");

    world.clock.ms = sentAt + HOUR - 1;
    early.source.items.push(world.item("1 時間に 1 ミリ秒足りない"));
    await world.fetchFeed(early.feedId);
    world.clock.ms = sentAt + HOUR;
    onTime.source.items.push(world.item("ちょうど 1 時間"));
    await world.fetchFeed(onTime.feedId);

    expect(world.service.delivered(endpoint)).toHaveLength(21);
    expect(titles(world.service, endpoint).at(-1)).toBe("ちょうど 1 時間");
  });

  it("2 つの取得の仕事が同じ人の 20 通目を同時に作っても、送るのは 1 通だけ", async () => {
    const world = createWorld();
    const user = await createReader(world);
    const feeds = await feedsOf(world, user, 9);
    const { endpoint } = await user.register();
    await publish(world, feeds, 19);
    const [a, b] = feeds.slice(7);
    if (!a || !b) throw new Error("no feed");
    a.source.items.push(world.item("A の記事"));
    b.source.items.push(world.item("B の記事"));
    // A の仕事が判定を読んだあと、行を作る直前に、B の取得の仕事が最後まで動く
    world.before(/insert into "bell_notifications"/i, async () => {
      await runJob(world.platform, { type: "fetch-feed", feedId: b.feedId });
    });

    await world.fetchFeed(a.feedId);

    expect(world.service.delivered(endpoint)).toHaveLength(20);
    expect(titles(world.service, endpoint).filter((t) => t.endsWith("の記事"))).toEqual([
      "B の記事",
    ]);
  });
});

describe("プッシュサービスの応答", () => {
  it.each([410, 404])("%i を返したら、その登録を消し、次から送らない", async (status) => {
    const world = createWorld();
    const { user, source, feedId, endpoint } = await belledReader(world);
    const other = await user.register();
    world.service.respondWith(
      (to) => new Response(null, { status: to === endpoint ? status : 201 }),
    );
    source.items.push(world.item("1 件目"));
    await world.fetchFeed(feedId);
    world.advance(MINUTE);
    await world.drain();

    world.advance(SECOND);
    source.items.push(world.item("2 件目"));
    await world.fetchFeed(feedId);

    expect(world.service.requests.filter((r) => r.endpoint === endpoint)).toHaveLength(1);
    expect(titles(world.service, other.endpoint)).toEqual(["1 件目", "2 件目"]);
    const rows = await testDb
      .prepare("SELECT count(*) AS n FROM push_registrations WHERE endpoint = ?")
      .bind(endpoint)
      .first<number>("n");
    expect(rows).toBe(0);
  });

  it("500 を返したら、1 分後にやり直して届ける。その間も記事の取り込みは成功している", async () => {
    const world = createWorld();
    const { user, source, feedId, endpoint } = await belledReader(world);
    let failures = 1;
    world.service.respondWith(() => new Response(null, { status: failures-- > 0 ? 500 : 201 }));
    source.items.push(world.item("新しい記事"));

    await world.fetchFeed(feedId);
    expect(titles(world.service)).toEqual([]);
    expect(await user.articleId("新しい記事")).toEqual(expect.any(String));

    world.advance(MINUTE);
    await world.drain();
    expect(world.service.requests.map((r) => r.status)).toEqual([500, 201]);
    expect(titles(world.service, endpoint)).toEqual(["新しい記事"]);
  });

  it("つながらないときもやり直す。3 回失敗したら諦め、登録は残す", async () => {
    const world = createWorld();
    const { user, source, feedId, endpoint } = await belledReader(world);
    const attempts: string[] = [];
    const original = world.platform.fetch;
    world.platform.fetch = async (input, init) => {
      if (String(input).includes(".push.example/")) {
        attempts.push(String(input));
        throw new TypeError("fetch failed", {
          cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
        });
      }
      return original(input, init);
    };
    vi.spyOn(console, "error").mockImplementation(() => {});
    source.items.push(world.item("新しい記事"));

    await world.fetchFeed(feedId);
    for (let i = 0; i < 3; i++) {
      world.advance(MINUTE);
      await world.drain();
    }

    expect(attempts).toHaveLength(3);
    const left = await testDb.prepare("SELECT count(*) AS n FROM job_queue").first<number>("n");
    expect(left).toBe(0);
    expect(await user.registeredEndpoints()).toEqual([endpoint]);
  });

  it("15 秒のうちに応答を受け終えなければ時間切れにし、仕事をやり直す", async () => {
    const world = createWorld();
    const { source, feedId, endpoint } = await belledReader(world);
    // 本物の 15 秒を待たないよう、時間切れの signal を、テストが切れるものに差し替える
    const timeouts: { ms: number; controller: AbortController }[] = [];
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      timeouts.push({ ms, controller });
      return controller.signal;
    });
    let stalled: AbortSignal | undefined;
    const { promise: sending, resolve: reached } = Promise.withResolvers<void>();
    const original = world.platform.fetch;
    world.platform.fetch = (input, init) => {
      const signal = init?.signal;
      if (stalled === undefined && String(input) === endpoint && signal) {
        // プッシュサービスが応答を返さない
        stalled = signal;
        reached();
        return new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason));
        });
      }
      return original(input, init);
    };
    vi.spyOn(console, "error").mockImplementation(() => {});
    source.items.push(world.item("新しい記事"));

    const fetching = world.fetchFeed(feedId);
    await sending;
    const timer = timeouts.find((t) => t.controller.signal === stalled);
    expect(timer?.ms).toBe(15 * SECOND);
    timer?.controller.abort(new DOMException("signal timed out", "TimeoutError"));
    await fetching;
    expect(titles(world.service, endpoint)).toEqual([]);

    world.advance(MINUTE);
    await world.drain();
    expect(titles(world.service, endpoint)).toEqual(["新しい記事"]);
  });

  it("429 ／ 503 で Retry-After が 1 分ちょうどならやり直し、1 分より先なら諦める", async () => {
    for (const status of [429, 503]) {
      const world = createWorld();
      const { source, feedId, endpoint } = await belledReader(world);
      const waits = ["61", "60"];
      world.service.respondWith(() => {
        const wait = waits.shift();
        return wait
          ? new Response(null, { status, headers: { "retry-after": wait } })
          : new Response(null, { status: 201 });
      });
      vi.spyOn(console, "warn").mockImplementation(() => {});
      source.items.push(world.item("諦める"));
      await world.fetchFeed(feedId);
      world.advance(MINUTE);
      await world.drain();

      source.items.push(world.item("やり直す"));
      await world.fetchFeed(feedId);
      world.advance(MINUTE);
      await world.drain();

      expect(
        world.service.requests.map((r) => r.status),
        String(status),
      ).toEqual([status, status, 201]);
      expect(titles(world.service, endpoint)).toEqual(["やり直す"]);
    }
  });

  it("3xx とそのほかの 4xx は、やり直さず、リダイレクトも追わず、状態コードをログに出す", async () => {
    const world = createWorld();
    const { source, feedId, endpoint } = await belledReader(world);
    const elsewhere = `https://${crypto.randomUUID()}.push.example/elsewhere`;
    const statuses = [307, 400];
    world.service.respondWith(
      () =>
        new Response(null, { status: statuses.shift() ?? 201, headers: { location: elsewhere } }),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    source.items.push(world.item("1 件目"), world.item("2 件目", 2 * MINUTE));

    await world.fetchFeed(feedId);
    world.advance(MINUTE);
    await world.drain();

    expect(world.service.requests.map((r) => [r.endpoint, r.status]).sort()).toEqual([
      [endpoint, 307],
      [endpoint, 400],
    ]);
    expect(warn).toHaveBeenCalledWith("push service refused the notification", { status: 307 });
    expect(warn).toHaveBeenCalledWith("push service refused the notification", { status: 400 });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(endpoint);
  });

  it.each([401, 403])(
    "%i を返したら、作ってから 1 時間以上たった JWT を捨て、次の送信で作り直す。1 時間に 1 ミリ秒足りなければ使い回す",
    async (status) => {
      const world = createWorld();
      const { source, feedId, endpoint } = await belledReader(world);
      const statuses = [201, status, 201, status, 201];
      world.service.respondWith(() => new Response(null, { status: statuses.shift() ?? 201 }));
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const createdAt = world.clock.ms;
      const send = async (title: string, at: number) => {
        world.clock.ms = at;
        source.items.push(world.item(title));
        await world.fetchFeed(feedId);
      };

      await send("JWT を作る", createdAt);
      await send("1 時間に 1 ミリ秒足りずに断られる", createdAt + HOUR - 1);
      await send("使い回す", createdAt + HOUR - 1);
      await send("1 時間ちょうどで断られる", createdAt + HOUR);
      // 同じ窓に入らないよう、10 分あける
      const renewedAt = createdAt + HOUR + 10 * MINUTE;
      await send("作り直す", renewedAt);

      const requests = world.service.requests.filter((r) => r.endpoint === endpoint);
      expect(requests.map((r) => [r.payload.notification.body, r.status])).toEqual([
        ["JWT を作る", 201],
        ["1 時間に 1 ミリ秒足りずに断られる", status],
        ["使い回す", 201],
        ["1 時間ちょうどで断られる", status],
        ["作り直す", 201],
      ]);
      const [first, ...rest] = requests.map((r) => r.vapid);
      expect(rest.slice(0, 3).map((vapid) => vapid.token)).toEqual(Array(3).fill(first?.token));
      expect(rest[3]?.token).not.toBe(first?.token);
      expect(rest[3]?.claims.exp).toBe((renewedAt + 12 * HOUR) / SECOND);
      expect(warn).toHaveBeenCalledWith("push service refused the notification", { status });
    },
  );

  // 本物の createSafeFetch で https を通るのはこのテストだけで、プロセスで最初の TLS の準備に時間がかかる。
  // NODE_USE_SYSTEM_CA=1 の macOS では、OS の証明書を読むのに 1 秒ほどかかり、テストを並べて回すと
  // 10 秒を超えることもある。前もって 1 回呼んでも、その呼び出しが同じだけ待つので、時間切れを長くする
  const SLOW_FIRST_TLS_MS = 30_000;

  it("エンドポイントが内部の IP に解決されたら送らず、その登録を消す（SSRF）", {
    timeout: SLOW_FIRST_TLS_MS,
  }, async () => {
    const world = createWorld({ resolve: async () => [{ address: "10.0.0.1", family: 4 }] });
    const { source, feedId, endpoint } = await belledReader(world);
    source.items.push(world.item("新しい記事"));

    await world.fetchFeed(feedId);

    expect(world.service.requests).toEqual([]);
    const rows = await testDb
      .prepare("SELECT count(*) AS n FROM push_registrations WHERE endpoint = ?")
      .bind(endpoint)
      .first<number>("n");
    expect(rows).toBe(0);
    const left = await testDb.prepare("SELECT count(*) AS n FROM job_queue").first<number>("n");
    expect(left).toBe(0);
  });
});

describe("送る前の取り消しと失敗", () => {
  it("登録を解除した端末には送らない", async () => {
    const world = createWorld();
    const { user, source, feedId, endpoint, headers } = await belledReader(world);
    const other = await user.register();
    const res = await requestApp(world.platform, "/api/v1/push/registration", {
      method: "DELETE",
      token: null,
      headers,
    });
    expect(res.status).toBe(204);
    source.items.push(world.item("新しい記事"));

    await world.fetchFeed(feedId);

    expect(titles(world.service, endpoint)).toEqual([]);
    expect(titles(world.service, other.endpoint)).toEqual(["新しい記事"]);
  });

  it("セッションの期限が切れた端末には送らない", async () => {
    const world = createWorld();
    const { user, source, feedId, endpoint } = await belledReader(world);
    const registeredAt = world.clock.ms - SECOND;
    world.clock.ms = registeredAt + SESSION_TTL_MS - MINUTE;
    const fresh = await user.register();
    world.clock.ms = registeredAt + SESSION_TTL_MS;
    source.items.push(world.item("新しい記事"));

    await world.fetchFeed(feedId);

    expect(titles(world.service, endpoint)).toEqual([]);
    expect(titles(world.service, fresh.endpoint)).toEqual(["新しい記事"]);
  });

  it("期限の切れたセッションの登録しかない人には、通知の行を作らず、上限も使わない。期限の 1 ミリ秒前なら作って送る", async () => {
    const world = createWorld();
    const { source, feedId, bellId, endpoint } = await belledReader(world);
    const expiresAt = world.clock.ms - SECOND + SESSION_TTL_MS;
    const rows = () =>
      testDb
        .prepare("SELECT count(*) AS n FROM bell_notifications WHERE bell_id = ?")
        .bind(bellId)
        .first<number>("n");

    world.clock.ms = expiresAt - 1;
    source.items.push(world.item("期限の 1 ミリ秒前の記事"));
    await world.fetchFeed(feedId);
    expect(await rows()).toBe(1);

    // 同じ窓の 2 件目なので、期限が切れていなければ 1 件で送る
    world.clock.ms = expiresAt;
    source.items.push(world.item("期限ちょうどの記事"));
    await world.fetchFeed(feedId);

    expect(await rows()).toBe(1);
    expect(titles(world.service, endpoint)).toEqual(["期限の 1 ミリ秒前の記事"]);
  });

  it("期限の切れた間に当たった記事は、窓が閉じる前に登録し直しても、まとめて送らない", async () => {
    const world = createWorld();
    const { user, source, feedId } = await belledReader(world);
    world.clock.ms = world.clock.ms - SECOND + SESSION_TTL_MS;
    for (let i = 1; i <= 4; i++) {
      source.items.push(world.item(`期限の切れた間の記事 ${i}`, (5 - i) * MINUTE));
    }
    await world.fetchFeed(feedId);
    const fresh = await user.register();
    world.advance(MINUTE);
    source.items.push(world.item("登録し直したあとの記事"));
    await world.fetchFeed(feedId);

    world.advance(10 * MINUTE);
    await world.drain();

    expect(titles(world.service, fresh.endpoint)).toEqual(["登録し直したあとの記事"]);
  });

  it("送る仕事を積んだあと、送る前にその端末でログアウトしたら、その端末には送らない", async () => {
    const world = createWorld();
    const { user, source, feedId, endpoint, headers } = await belledReader(world);
    const other = await user.register();
    source.items.push(world.item("新しい記事"));
    // 送る仕事が通知の行と端末を読む直前に、ログアウトする
    world.before(/from "bell_notifications" as notification/i, async () => {
      const res = await requestApp(world.platform, "/api/v1/auth/logout", {
        method: "POST",
        token: null,
        headers,
      });
      expect(res.status).toBe(204);
    });

    await world.fetchFeed(feedId);

    expect(titles(world.service, endpoint)).toEqual([]);
    expect(titles(world.service, other.endpoint)).toEqual(["新しい記事"]);
  });

  it("判定を読んだあと、行を作る前にベルを外したら、行を作らず送らない", async () => {
    const world = createWorld();
    const { user, source, feedId, bellId } = await belledReader(world);
    source.items.push(world.item("新しい記事"));
    world.before(/insert into "bell_notifications"/i, async () => {
      expect((await user.api(`/bells/${bellId}`, "DELETE")).status).toBe(204);
    });

    await world.fetchFeed(feedId);

    expect(world.service.requests).toEqual([]);
    const rows = await testDb
      .prepare("SELECT count(*) AS n FROM bell_notifications WHERE bell_id = ?")
      .bind(bellId)
      .first<number>("n");
    expect(rows).toBe(0);
  });

  it("送る仕事を積んだあと、送る前にベルを外したら送らない", async () => {
    const world = createWorld();
    const { user, source, feedId, bellId } = await belledReader(world);
    source.items.push(world.item("新しい記事"));
    world.before(/from "bell_notifications" as notification/i, async () => {
      expect((await user.api(`/bells/${bellId}`, "DELETE")).status).toBe(204);
    });

    await world.fetchFeed(feedId);

    expect(world.service.requests).toEqual([]);
  });

  it("送る仕事を積んだあと、送る前に購読をやめたら送らない", async () => {
    const world = createWorld();
    const { user, source, feedId } = await belledReader(world);
    source.items.push(world.item("新しい記事"));
    world.before(/from "bell_notifications" as notification/i, async () => {
      expect((await user.api(`/feeds/${feedId}`, "DELETE")).status).toBe(204);
    });

    await world.fetchFeed(feedId);

    expect(world.service.requests).toEqual([]);
  });

  it("判定を読んだあと、行を作る前にほかの端末で記事を読んだら、行を作らず送らない", async () => {
    const world = createWorld();
    const { user, source, feedId, bellId } = await belledReader(world);
    source.items.push(world.item("新しい記事"));
    world.before(/insert into "bell_notifications"/i, async () => {
      const id = await user.articleId("新しい記事");
      expect((await user.api(`/articles/${id}`, "PATCH", { read: true })).status).toBe(200);
    });

    await world.fetchFeed(feedId);

    expect(world.service.requests).toEqual([]);
    const rows = await testDb
      .prepare("SELECT count(*) AS n FROM bell_notifications WHERE bell_id = ?")
      .bind(bellId)
      .first<number>("n");
    expect(rows).toBe(0);
  });

  it("送る仕事を積んだあと、送る前にほかの端末で記事を読んだら送らない", async () => {
    const world = createWorld();
    const { user, source, feedId } = await belledReader(world);
    source.items.push(world.item("新しい記事"));
    world.before(/from "bell_notifications" as notification/i, async () => {
      const id = await user.articleId("新しい記事");
      expect((await user.api(`/articles/${id}`, "PATCH", { read: true })).status).toBe(200);
    });

    await world.fetchFeed(feedId);

    expect(world.service.requests).toEqual([]);
  });

  it("送る仕事を積んだあと、送る前に記事が受信箱から消えたら送らない", async () => {
    const world = createWorld();
    const { user, source, feedId } = await belledReader(world);
    source.items.push(world.item("新しい記事"));
    world.before(/from "bell_notifications" as notification/i, async () => {
      // 古い記事の片付けは、受信箱の行を消してから記事の行を消す（docs/decisions/retention.md）。
      // その間に送る仕事が動いた
      await testDb
        .prepare("DELETE FROM user_articles WHERE user_id = ? AND article_id = ?")
        .bind(user.id, await user.articleId("新しい記事"))
        .run();
    });

    await world.fetchFeed(feedId);

    expect(world.service.requests).toEqual([]);
  });

  it("やり直しを待つ間に同じセッションで登録し直したら、古い仕事は新しいエンドポイントに送らず、登録は新しい 1 つが残る", async () => {
    const world = createWorld();
    const { user, source, feedId, endpoint, headers } = await belledReader(world);
    world.service.respondWith((to) => new Response(null, { status: to === endpoint ? 500 : 201 }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    source.items.push(world.item("新しい記事"));
    await world.fetchFeed(feedId);
    const renewed = await user.reregister(headers);

    world.advance(MINUTE);
    await world.drain();

    expect(world.service.requests.map((r) => [r.endpoint, r.status])).toEqual([[endpoint, 500]]);
    expect(await user.registeredEndpoints()).toEqual([renewed.endpoint]);
    // 新しい登録には、次の記事から届く
    world.advance(SECOND);
    source.items.push(world.item("次の記事"));
    await world.fetchFeed(feedId);
    expect(titles(world.service, renewed.endpoint)).toEqual(["次の記事"]);
  });

  it("送っている間に同じセッションで登録し直し、古い仕事が 410 を受けても、新しい登録は消さない", async () => {
    const world = createWorld();
    const { user, source, feedId, endpoint, headers } = await belledReader(world);
    let renewed: { endpoint: string } | undefined;
    world.service.respondWith(async (to) => {
      if (to !== endpoint) return new Response(null, { status: 201 });
      renewed = await user.reregister(headers);
      return new Response(null, { status: 410 });
    });
    source.items.push(world.item("1 件目"));

    await world.fetchFeed(feedId);

    if (!renewed) throw new Error("not re-registered");
    expect(await user.registeredEndpoints()).toEqual([renewed.endpoint]);
    world.advance(SECOND);
    source.items.push(world.item("2 件目"));
    await world.fetchFeed(feedId);
    expect(titles(world.service, renewed.endpoint)).toEqual(["2 件目"]);
  });

  it("1 件の記事の通知の行を作るのに失敗しても、同じ回の残りの記事は送る", async () => {
    const world = createWorld();
    const { user, source, feedId, endpoint } = await belledReader(world);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    source.items.push(world.item("古い記事", 2 * MINUTE), world.item("新しい記事"));
    // 行は公開日時の古い順に作る。古い記事の行を作る文だけが、一時的に失敗する
    world.before(/insert into "bell_notifications"/i, async () => {
      throw new Error("database is locked");
    });

    await world.fetchFeed(feedId);

    expect(titles(world.service, endpoint)).toEqual(["新しい記事"]);
    expect(error).toHaveBeenCalledWith(
      "could not notify bells",
      expect.objectContaining({ articleId: await user.articleId("古い記事") }),
    );
  });

  it("通知の行を作ってから送る仕事を積む前に落ちても、取得は成功する。その通知は出ず、取得し直しても 2 通にならない", async () => {
    const world = createWorld();
    const { user, source, feedId } = await belledReader(world);
    source.items.push(world.item("新しい記事"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    world.before(/insert into "bell_notifications"/i, async () => {
      world.before(/insert into "job_queue"/i, async () => {
        throw new Error("crashed before enqueueing");
      });
    });

    const lastSuccess = async () => {
      const { items } = (await (await user.api("/feeds")).json()) as {
        items: { id: string; lastSuccessfulFetchAt: string | null }[];
      };
      return items.find((item) => item.id === feedId)?.lastSuccessfulFetchAt;
    };

    await world.fetchFeed(feedId);
    expect(await lastSuccess()).toBe(new Date(world.clock.ms).toISOString());
    expect(error).toHaveBeenCalledWith("could not notify bells", expect.anything());
    world.advance(MINUTE);
    await world.fetchFeed(feedId);

    expect(await user.articleId("新しい記事")).toEqual(expect.any(String));
    expect(world.service.requests).toEqual([]);
  });

  it("Web Push が使えない設定では、判定せず、行も作らない", async () => {
    const world = createWorld();
    const { source, feedId, bellId } = await belledReader(world);
    delete world.platform.push;
    source.items.push(world.item("新しい記事"));

    await world.fetchFeed(feedId);

    expect(world.service.requests).toEqual([]);
    const rows = await testDb
      .prepare("SELECT count(*) AS n FROM bell_notifications WHERE bell_id = ?")
      .bind(bellId)
      .first<number>("n");
    expect(rows).toBe(0);
  });
});
