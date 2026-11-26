import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSession, SESSION_TTL_MS } from "../../src/db/sessions";
import { runJob } from "../../src/jobs";
import { runCleanUp } from "../../src/jobs/clean-up";
import { MAX_CONTENT_BYTES, MAX_CONTENTS_PER_FETCH } from "../../src/jobs/fetch-feed";
import type { Job } from "../../src/jobs/job";
import { createSqliteJobQueue } from "../../src/platform/node/job-queue";
import { createSafeFetch, type Resolver } from "../../src/platform/node/safe-fetch";
import { testDb } from "../db";
import { clockedDatabase, createTestPlatform, createUser, fakeFetch, requestApp } from "../helpers";
import { createDevice, createPushService, type Device, type PushService } from "../push-service";

/*
 * ベルの記事を Web Push で送る（docs/decisions/notifications.md の 8〜16、21、22）。
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

/** フィードの記事。description は要約に、content はフィードの本文（HTML）になる */
type Item = {
  guid: string;
  title: string;
  publishedAt: Date | null;
  description?: string;
  content?: string;
};

const escapeXml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

function rss(items: readonly Item[], title: string) {
  return `<?xml version="1.0"?><rss version="2.0"
    xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>${escapeXml(title)}</title>
    <link>https://blog.example/</link>${items
      .map(
        (item) =>
          `<item><title>${escapeXml(item.title)}</title><guid isPermaLink="false">${item.guid}</guid>${
            item.publishedAt ? `<pubDate>${item.publishedAt.toUTCString()}</pubDate>` : ""
          }${item.description === undefined ? "" : `<description>${escapeXml(item.description)}</description>`}${
            item.content === undefined
              ? ""
              : `<content:encoded>${escapeXml(item.content)}</content:encoded>`
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
  const sources = new Map<string, { items: Item[]; title: string }>();
  const fake = fakeFetch((url, init) => {
    const source = sources.get(url.host);
    return source ? new Response(rss(source.items, source.title)) : service.receive(url, init);
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
    source(items: Item[] = [], title = "Blog") {
      const host = `${crypto.randomUUID()}.example.com`;
      sources.set(host, { items, title });
      return { url: `https://${host}/feed.xml`, items };
    },
    /** 取得の仕事を積んで、送る仕事まで動かす（定期実行が積むのと同じ仕事） */
    async fetchFeed(feedId: string) {
      await jobs.enqueue([{ type: "fetch-feed", feedId }]);
      await drain();
    },
    /** まとめの仕事を積んで、送る仕事まで動かす（定期実行が積むのと同じ仕事） */
    async bundle() {
      await jobs.enqueue([{ type: "bundle-bell-notifications" }]);
      await drain();
    },
    /** 今の時刻から ago だけ前に出た記事 */
    item(title: string, ago = MINUTE, fields: Pick<Item, "description" | "content"> = {}): Item {
      return { guid: crypto.randomUUID(), title, publishedAt: new Date(clock.ms - ago), ...fields };
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
  const inboxArticle = async (title: string) => {
    const res = await api("/articles?limit=100");
    const { items } = (await res.json()) as {
      items: { id: string; title: string | null; hasContent: boolean }[];
    };
    const found = items.find((item) => item.title === title);
    if (!found) throw new Error(`not in the inbox: ${title}`);
    return found;
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
    /** 言葉のベルを付ける。feedId を渡すと、購読 AND 言葉のベル */
    async wordBell(words: string, feedId?: string) {
      const res = await api("/bells", "POST", { words, feedId });
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
      return (await inboxArticle(title)).id;
    },
    /** 受信箱の記事に、置き場に置いた本文があるか */
    async hasContent(title: string) {
      return (await inboxArticle(title)).hasContent;
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
    await world.bundle();

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

describe("言葉のベル", () => {
  /** 購読して初回の取得を終えた購読（初回の取得の記事は送らない） */
  async function subscribed(world: World, user: Reader, title?: string) {
    const source = world.source([], title);
    const feedId = await user.subscribe(source);
    world.advance(SECOND);
    await world.drain();
    world.advance(SECOND);
    return { source, feedId };
  }

  /** 購読を用意してから、言葉だけのベルを付け、端末を登録した利用者 */
  async function wordReader(world: World, words: string, titles: string[] = ["Blog"]) {
    const user = await createReader(world);
    const feeds = [];
    for (const title of titles) feeds.push(await subscribed(world, user, title));
    const bellId = await user.wordBell(words);
    const { endpoint } = await user.register();
    world.advance(SECOND);
    return { user, feeds, bellId, endpoint };
  }

  /** 届いた通知。送る仕事は並んで動くので、届く順によらないよう、本文の順に並べる */
  const notifications = (service: PushService, endpoint: string) =>
    service
      .delivered(endpoint)
      .map((request) => request.payload.notification)
      .sort((a, b) => a.body.localeCompare(b.body));

  it("言葉「Azure 障害」のベルは、どの購読の記事でも、タイトルか要約かフィードの本文に両方があれば 1 通届き、title に言葉が出る", async () => {
    const world = createWorld();
    const { user, feeds, bellId, endpoint } = await wordReader(world, "Azure 障害", [
      "Blog",
      "News",
    ]);
    const [blog, news] = feeds;
    if (!blog || !news) throw new Error("no feed");
    blog.source.items.push(world.item("Azure の大規模障害", 3 * MINUTE));
    news.source.items.push(
      world.item("Azure の速報", 2 * MINUTE, { description: "障害が続いている" }),
      world.item("クラウドの話", MINUTE, {
        description: "Azure の更新",
        content: "<p>東日本で<b>障害</b>が起きた</p>",
      }),
    );

    await world.fetchFeed(blog.feedId);
    await world.fetchFeed(news.feedId);

    const expected = async (title: string, feed: string) => ({
      title: `Azure 障害 · ${feed}`,
      body: title,
      navigate: `${READER}/?article=${await user.articleId(title)}`,
      tag: `bell:${bellId}:${await user.articleId(title)}`,
      data: { bellId, articleId: await user.articleId(title), count: 1 },
    });
    expect(notifications(world.service, endpoint)).toEqual(
      [
        await expected("Azure の大規模障害", "Blog"),
        await expected("Azure の速報", "News"),
        await expected("クラウドの話", "News"),
      ].sort((a, b) => a.body.localeCompare(b.body)),
    );
  });

  it("言葉の片方しかない記事には送らない", async () => {
    const world = createWorld();
    const { feeds } = await wordReader(world, "Azure 障害");
    const [blog] = feeds;
    if (!blog) throw new Error("no feed");
    blog.source.items.push(
      world.item("Azure の新機能", 2 * MINUTE, { description: "東日本リージョン" }),
      world.item("大規模障害", MINUTE, { content: "<p>AWS で起きた</p>" }),
    );

    await world.fetchFeed(blog.feedId);

    expect(world.service.requests).toEqual([]);
  });

  it("小文字の「azure」にも、全角の「Ａｚｕｒｅ」にも当たる", async () => {
    const world = createWorld();
    const { feeds, endpoint } = await wordReader(world, "Azure 障害");
    const [blog] = feeds;
    if (!blog) throw new Error("no feed");
    blog.source.items.push(
      world.item("azure で障害", 2 * MINUTE),
      world.item("Ａｚｕｒｅの障害", MINUTE),
    );

    await world.fetchFeed(blog.feedId);

    expect(titles(world.service, endpoint).sort()).toEqual(
      ["azure で障害", "Ａｚｕｒｅの障害"].sort(),
    );
  });

  it("言葉「Go」のベルは、「Google」だけの記事に送らず、「Go 1.26」と「Go言語」の記事に送る", async () => {
    const world = createWorld();
    const { feeds, endpoint } = await wordReader(world, "Go");
    const [blog] = feeds;
    if (!blog) throw new Error("no feed");
    blog.source.items.push(
      world.item("Google の発表", 3 * MINUTE),
      world.item("Go 1.26 が出た", 2 * MINUTE),
      world.item("Go言語の入門", MINUTE),
    );

    await world.fetchFeed(blog.feedId);

    expect(titles(world.service, endpoint).sort()).toEqual(
      ["Go 1.26 が出た", "Go言語の入門"].sort(),
    );
  });

  it("「Hacker News AND Rust」のベルは、ほかの購読に出た「Rust」の記事には送らず、Hacker News の記事には送る", async () => {
    const world = createWorld();
    const user = await createReader(world);
    const hn = await subscribed(world, user, "Hacker News");
    const blog = await subscribed(world, user, "Blog");
    const bellId = await user.wordBell("Rust", hn.feedId);
    const { endpoint } = await user.register();
    world.advance(SECOND);
    blog.source.items.push(world.item("Rust 1.80"));
    hn.source.items.push(world.item("Rust 2.0"), world.item("Python 4.0"));

    await world.fetchFeed(blog.feedId);
    await world.fetchFeed(hn.feedId);

    expect(notifications(world.service, endpoint)).toEqual([
      expect.objectContaining({
        title: "Rust · Hacker News",
        body: "Rust 2.0",
        data: { bellId, articleId: await user.articleId("Rust 2.0"), count: 1 },
      }),
    ]);
  });

  it("1 件の記事が同じ人の複数のベルに当たっても 1 通だけ。購読 AND 言葉、言葉だけ、購読だけの順に選ぶ", async () => {
    const world = createWorld();
    const user = await createReader(world);
    const hn = await subscribed(world, user, "Hacker News");
    // 作った順は、選ぶ順と逆にする（作った時刻より種類を先に見る）
    const subscriptionOnly = await user.bell(hn.feedId);
    world.advance(SECOND);
    const wordsOnly = await user.wordBell("Rust");
    const { endpoint } = await user.register();
    world.advance(SECOND);
    hn.source.items.push(world.item("Rust 1.80"));

    await world.fetchFeed(hn.feedId);
    world.advance(SECOND);
    const both = await user.wordBell("rust", hn.feedId);
    world.advance(SECOND);
    hn.source.items.push(world.item("Rust 2.0", 2 * MINUTE), world.item("Python 4.0", MINUTE));
    await world.fetchFeed(hn.feedId);

    expect(
      notifications(world.service, endpoint).map(({ title, body, data }) => ({
        title,
        body,
        bellId: data.bellId,
      })),
    ).toEqual([
      { title: "Hacker News", body: "Python 4.0", bellId: subscriptionOnly },
      { title: "Rust · Hacker News", body: "Rust 1.80", bellId: wordsOnly },
      { title: "rust · Hacker News", body: "Rust 2.0", bellId: both },
    ]);
  });

  it("同じ種類のベルが 2 つ当たったら、作ったのが古いベルで送る", async () => {
    const world = createWorld();
    const user = await createReader(world);
    const blog = await subscribed(world, user);
    const older = await user.wordBell("Rust 1.80");
    world.advance(SECOND);
    await user.wordBell("Rust");
    const { endpoint } = await user.register();
    world.advance(SECOND);
    blog.source.items.push(world.item("Rust 1.80 が出た"));

    await world.fetchFeed(blog.feedId);

    expect(notifications(world.service, endpoint)).toEqual([
      expect.objectContaining({
        title: "Rust 1.80 · Blog",
        data: expect.objectContaining({ bellId: older }),
      }),
    ]);
  });

  it("購読をやめると、その購読 AND 言葉のベルは鳴らず、言葉だけのベルはほかの購読の記事で鳴る", async () => {
    const world = createWorld();
    const user = await createReader(world);
    const hn = await subscribed(world, user, "Hacker News");
    const blog = await subscribed(world, user, "Blog");
    await user.wordBell("Rust", hn.feedId);
    const wordsOnly = await user.wordBell("Rust");
    const { endpoint } = await user.register();
    expect((await user.api(`/feeds/${hn.feedId}`, "DELETE")).status).toBe(204);
    world.advance(SECOND);
    blog.source.items.push(world.item("Rust 1.80"));

    await world.fetchFeed(blog.feedId);

    expect(notifications(world.service, endpoint)).toEqual([
      expect.objectContaining({
        title: "Rust · Blog",
        data: expect.objectContaining({ bellId: wordsOnly }),
      }),
    ]);
  });

  it("言葉だけのベルも、購読したばかりの初回の取得で入った記事には送らない", async () => {
    const world = createWorld();
    const { user, endpoint } = await wordReader(world, "Rust");
    const fresh = world.source([world.item("Rust の古い記事", HOUR)]);
    const feedId = await user.subscribe(fresh);
    world.advance(SECOND);
    await world.drain();
    expect(world.service.requests).toEqual([]);

    world.advance(SECOND);
    fresh.items.push(world.item("Rust の新しい記事"));
    await world.fetchFeed(feedId);

    expect(titles(world.service, endpoint)).toEqual(["Rust の新しい記事"]);
  });

  it("フィードの本文は、空白をまとめたプレーンテキストの先頭ちょうど 20,000 文字で判定する", async () => {
    const world = createWorld();
    const { feeds, endpoint } = await wordReader(world, "障害");
    const [blog] = feeds;
    if (!blog) throw new Error("no feed");
    // どちらも 20,000 文字を超える本文。「障害」が 19,999〜20,000 文字目にある記事と、20,000〜20,001
    // 文字目にかかる記事。タグは空白になり、前後の空白は除く
    blog.source.items.push(
      world.item("20,000 文字目で終わる", 2 * MINUTE, {
        content: `<p>${"あ".repeat(19_998)}障害${"い".repeat(10)}</p>`,
      }),
      world.item("20,001 文字目にかかる", MINUTE, {
        content: `<p>${"あ".repeat(19_999)}障害${"い".repeat(10)}</p>`,
      }),
    );

    await world.fetchFeed(blog.feedId);

    expect(titles(world.service, endpoint)).toEqual(["20,000 文字目で終わる"]);
  });

  it("1 回の取得で本文を置く 30 件を超えた記事も、フィードの本文で判定する", async () => {
    const world = createWorld();
    const { user, feeds, endpoint } = await wordReader(world, "障害");
    const [blog] = feeds;
    if (!blog) throw new Error("no feed");
    // 要約は description から採るので、言葉は本文にだけある
    for (let i = 1; i <= MAX_CONTENTS_PER_FETCH; i++) {
      blog.source.items.push(
        world.item(`記事 ${i}`, MINUTE, { description: "要約", content: "<p>平常どおり</p>" }),
      );
    }
    blog.source.items.push(
      world.item("31 件目", MINUTE, { description: "要約", content: "<p>障害が起きた</p>" }),
    );

    await world.fetchFeed(blog.feedId);

    expect(await user.hasContent("31 件目")).toBe(false);
    expect(titles(world.service, endpoint)).toEqual(["31 件目"]);
  });

  it("大きすぎて置き場に置かなかった本文（256 KiB を超える）も判定する", async () => {
    const world = createWorld();
    const { user, feeds, endpoint } = await wordReader(world, "障害");
    const [blog] = feeds;
    if (!blog) throw new Error("no feed");
    const filler = "あ".repeat(Math.ceil(MAX_CONTENT_BYTES / 3) + 1);
    blog.source.items.push(
      world.item("大きな記事", MINUTE, {
        description: "要約",
        content: `<p>障害が起きた</p><p>${filler}</p>`,
      }),
    );

    await world.fetchFeed(blog.feedId);

    expect(await user.hasContent("大きな記事")).toBe(false);
    expect(titles(world.service, endpoint)).toEqual(["大きな記事"]);
  });

  it("言葉だけのベルのまとめは、title に言葉だけを出す", async () => {
    const world = createWorld();
    const { user, feeds, bellId, endpoint } = await wordReader(world, "Rust");
    const [blog] = feeds;
    if (!blog) throw new Error("no feed");
    for (let i = 1; i <= 4; i++) blog.source.items.push(world.item(`Rust ${i}`, (5 - i) * MINUTE));
    const opened = world.clock.ms;

    await world.fetchFeed(blog.feedId);
    world.clock.ms = opened + 10 * MINUTE;
    await world.bundle();

    const newest = await user.articleId("Rust 4");
    // 1〜3 件目のあとに、まとめが 1 通届く
    const delivered = world.service.delivered(endpoint).map((r) => r.payload.notification);
    expect(delivered.slice(3)).toEqual([
      {
        title: "Rust",
        body: "Rust 4",
        navigate: `${READER}/?article=${newest}`,
        tag: `bell:${bellId}:${newest}`,
        data: { bellId, articleId: newest, count: 1 },
      },
    ]);
  });

  /** そのベルの通知の行の数。まとめの行だけを数えるなら bundles を true にする */
  const rowsOf = (bellId: string, bundles = false) =>
    testDb
      .prepare(
        `SELECT count(*) AS n FROM bell_notifications WHERE bell_id = ?${bundles ? " AND article_id IS NULL" : ""}`,
      )
      .bind(bellId)
      .first<number>("n");

  it("判定を読んだあと、行を作る前に購読をやめたら、言葉だけのベルでも行を作らず送らない", async () => {
    const world = createWorld();
    const { user, feeds, bellId } = await wordReader(world, "Rust");
    const [blog] = feeds;
    if (!blog) throw new Error("no feed");
    blog.source.items.push(world.item("Rust 1.80"));
    world.before(/insert into "bell_notifications"/i, async () => {
      expect((await user.api(`/feeds/${blog.feedId}`, "DELETE")).status).toBe(204);
    });

    await world.fetchFeed(blog.feedId);

    expect(world.service.requests).toEqual([]);
    expect(await rowsOf(bellId)).toBe(0);
  });

  it("送る仕事を積んだあと、送る前に購読をやめたら、言葉だけのベルでも送らない", async () => {
    const world = createWorld();
    const { user, feeds } = await wordReader(world, "Rust");
    const [blog] = feeds;
    if (!blog) throw new Error("no feed");
    blog.source.items.push(world.item("Rust 1.80"));
    world.before(/from "bell_notifications" as notification/i, async () => {
      expect((await user.api(`/feeds/${blog.feedId}`, "DELETE")).status).toBe(204);
    });

    await world.fetchFeed(blog.feedId);

    expect(world.service.requests).toEqual([]);
  });

  it("まとめ待ちの間に購読をやめたら、言葉だけのベルでもまとめず、まとめの行も作らない", async () => {
    const world = createWorld();
    const { user, feeds, bellId, endpoint } = await wordReader(world, "Rust");
    const [blog] = feeds;
    if (!blog) throw new Error("no feed");
    for (let i = 1; i <= 4; i++) blog.source.items.push(world.item(`Rust ${i}`, (5 - i) * MINUTE));
    const opened = world.clock.ms;
    await world.fetchFeed(blog.feedId);
    expect(world.service.delivered(endpoint)).toHaveLength(3);
    expect((await user.api(`/feeds/${blog.feedId}`, "DELETE")).status).toBe(204);

    world.clock.ms = opened + 10 * MINUTE;
    await world.bundle();

    expect(world.service.delivered(endpoint)).toHaveLength(3);
    // 1 時間 20 通の上限に数えるまとめの行も作らない
    expect(await rowsOf(bellId, true)).toBe(0);
  });

  it("まとめの窓を拾ってから行を作るまでに購読をやめたら、言葉だけのベルでもまとめの行を作らない", async () => {
    const world = createWorld();
    const { user, feeds, bellId, endpoint } = await wordReader(world, "Rust");
    const [blog] = feeds;
    if (!blog) throw new Error("no feed");
    for (let i = 1; i <= 4; i++) blog.source.items.push(world.item(`Rust ${i}`, (5 - i) * MINUTE));
    const opened = world.clock.ms;
    await world.fetchFeed(blog.feedId);
    world.clock.ms = opened + 10 * MINUTE;
    world.before(/insert into "bell_notifications"/i, async () => {
      expect((await user.api(`/feeds/${blog.feedId}`, "DELETE")).status).toBe(204);
    });

    await world.bundle();

    expect(world.service.delivered(endpoint)).toHaveLength(3);
    expect(await rowsOf(bellId, true)).toBe(0);
  });

  it("まとめ待ちの間に一部の購読をやめたら、受信箱に残る記事だけをまとめ、その数を載せる", async () => {
    const world = createWorld();
    const { user, feeds, endpoint } = await wordReader(world, "Rust", ["Blog", "News"]);
    const [blog, news] = feeds;
    if (!blog || !news) throw new Error("no feed");
    const opened = world.clock.ms;
    for (let i = 1; i <= 3; i++) blog.source.items.push(world.item(`Rust ${i}`, (6 - i) * MINUTE));
    await world.fetchFeed(blog.feedId);
    // 4 件目からはまとめ待ち
    news.source.items.push(world.item("Rust 4", 2 * MINUTE));
    blog.source.items.push(world.item("Rust 5", MINUTE));
    await world.fetchFeed(news.feedId);
    await world.fetchFeed(blog.feedId);
    expect(world.service.delivered(endpoint)).toHaveLength(3);
    expect((await user.api(`/feeds/${blog.feedId}`, "DELETE")).status).toBe(204);

    world.clock.ms = opened + 10 * MINUTE;
    await world.bundle();

    const bundles = world.service.delivered(endpoint).slice(3);
    expect(bundles.map((r) => r.payload.notification)).toEqual([
      expect.objectContaining({ body: "Rust 4", data: expect.objectContaining({ count: 1 }) }),
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
    world.clock.ms = opened + 10 * MINUTE;
    source.items.push(world.item("ちょうど 10 分"));
    await world.fetchFeed(feedId);

    expect(titles(world.service, endpoint).sort()).toEqual(
      ["1", "2", "3", "ちょうど 10 分"].sort(),
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

  it("窓が閉じたら、4 件目からを 1 通にまとめ、新しい順に 3 件のタイトルと「ほか n 件」を並べ、いちばん新しい記事を開く", async () => {
    const world = createWorld();
    const reader = await belledReader(world);
    const { user, endpoint, bellId } = reader;
    const opened = await hits(world, reader, 7);
    expect(titles(world.service, endpoint).sort()).toEqual(["記事 1", "記事 2", "記事 3"]);

    world.clock.ms = opened + 10 * MINUTE;
    await world.bundle();

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

  it("窓に 3 件ちょうどなら、まとめを作らない", async () => {
    const world = createWorld();
    const reader = await belledReader(world);
    const opened = await hits(world, reader, 3);

    world.clock.ms = opened + 10 * MINUTE;
    await world.bundle();

    expect(titles(world.service, reader.endpoint).sort()).toEqual(["記事 1", "記事 2", "記事 3"]);
  });

  it("窓の始まりから 10 分ちょうどで閉じ、1 ミリ秒前はまだ拾わない。1 つの窓のまとめは 1 通だけ", async () => {
    const world = createWorld();
    const reader = await belledReader(world);
    const opened = await hits(world, reader, 4);

    world.clock.ms = opened + 10 * MINUTE - 1;
    await world.bundle();
    expect(world.service.delivered(reader.endpoint)).toHaveLength(3);

    world.clock.ms = opened + 10 * MINUTE;
    await world.bundle();
    world.advance(5 * MINUTE);
    await world.bundle();

    expect(titles(world.service, reader.endpoint).slice(3)).toEqual(["記事 4"]);
  });

  it("閉じてから 1 時間以内の窓だけを拾う。始まりから 70 分ちょうどの窓は拾わず、1 ミリ秒前なら拾う", async () => {
    const world = createWorld();
    const late = await belledReader(world);
    const onTime = await belledReader(world);
    const lateOpened = await hits(world, late, 4);
    world.clock.ms = lateOpened + 1;
    await hits(world, onTime, 4);

    // late の窓は始まりから 70 分ちょうど、onTime の窓は 70 分に 1 ミリ秒足りない
    world.clock.ms = lateOpened + 70 * MINUTE;
    await world.bundle();

    expect(world.service.delivered(late.endpoint)).toHaveLength(3);
    expect(titles(world.service, onTime.endpoint).slice(3)).toEqual(["記事 4"]);
  });

  it("まとめる前にベルを外したら、まとめない", async () => {
    const world = createWorld();
    const reader = await belledReader(world);
    const opened = await hits(world, reader, 4);
    expect((await reader.user.api(`/bells/${reader.bellId}`, "DELETE")).status).toBe(204);

    world.clock.ms = opened + 10 * MINUTE;
    await world.bundle();

    expect(world.service.delivered(reader.endpoint)).toHaveLength(3);
  });

  it("まとめの窓を拾ってから行を作るまでにベルを外したら、まとめない", async () => {
    const world = createWorld();
    const reader = await belledReader(world);
    const opened = await hits(world, reader, 4);
    world.clock.ms = opened + 10 * MINUTE;
    world.before(/insert into "bell_notifications"/i, async () => {
      expect((await reader.user.api(`/bells/${reader.bellId}`, "DELETE")).status).toBe(204);
    });

    await world.bundle();

    expect(world.service.delivered(reader.endpoint)).toHaveLength(3);
    // 送るときにもベルを確かめるが、まとめの行そのものを作らない
    const bundles = await testDb
      .prepare(
        "SELECT count(*) AS n FROM bell_notifications WHERE bell_id = ? AND article_id IS NULL",
      )
      .bind(reader.bellId)
      .first<number>("n");
    expect(bundles).toBe(0);
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

    await world.bundle();

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
    await world.bundle();

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
    await world.bundle();

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
    await world.bundle();

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

    await world.bundle();
    // まとめの仕事のやり直しと、次の定期実行
    world.advance(MINUTE);
    await world.drain();
    world.advance(5 * MINUTE);
    await world.bundle();

    expect(world.service.delivered(reader.endpoint)).toHaveLength(3);
    const bundles = await testDb
      .prepare(
        "SELECT count(*) AS n FROM bell_notifications WHERE bell_id = ? AND article_id IS NULL",
      )
      .bind(reader.bellId)
      .first<number>("n");
    expect(bundles).toBe(1);
  });

  it("まとめの仕事が 1 回に拾う窓は 100 個まで。101 個目は次の回に拾う", async () => {
    const world = createWorld();
    const source = world.source([world.item("前からある記事", HOUR)]);
    // 送り先のオリジンをそろえ、JWT を使い回させる
    const device = await createDevice();
    const host = `${crypto.randomUUID()}.push.example`;
    // 101 人が同じフィードにベルを付ける。1 回の取得で、どの人にも同じ時刻に 4 件当たる
    const endpoints = new Set<string>();
    let feedId = "";
    for (let i = 0; i < 101; i++) {
      const user = await createReader(world);
      feedId = await user.subscribe(source);
      await user.bell(feedId);
      endpoints.add((await user.register(device, host)).endpoint);
    }
    world.advance(SECOND);
    await world.drain();
    world.advance(SECOND);
    const opened = await hits(world, { source, feedId }, 4);
    expect(world.service.delivered()).toHaveLength(303);

    world.clock.ms = opened + 10 * MINUTE;
    await world.bundle();
    expect(world.service.delivered().slice(303)).toHaveLength(100);
    await world.bundle();

    const bundles = world.service.delivered().slice(303);
    expect(bundles).toHaveLength(101);
    expect(new Set(bundles.map((r) => r.endpoint))).toEqual(endpoints);
  }, 60_000);
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

  it("エンドポイントが内部の IP に解決されたら送らず、その登録を消す（SSRF）", async () => {
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

  it("判定を読んだあと、行を作る前に選ぶはずのベルを外したら、同じ記事に当たった次の順のベルで送る", async () => {
    const world = createWorld();
    const { user, source, feedId, bellId } = await belledReader(world);
    const wordsOnly = await user.wordBell("Rust");
    world.advance(SECOND);
    source.items.push(world.item("Rust 1.80"));
    world.before(/insert into "bell_notifications"/i, async () => {
      expect((await user.api(`/bells/${wordsOnly}`, "DELETE")).status).toBe(204);
    });

    await world.fetchFeed(feedId);

    expect(world.service.requests.map((r) => r.payload.notification)).toEqual([
      expect.objectContaining({ title: "Blog", data: expect.objectContaining({ bellId }) }),
    ]);
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
