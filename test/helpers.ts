import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { createApp } from "../src/app";
import { insertFeed } from "../src/db/feeds";
import * as schema from "../src/db/schema";
import { nextSeq } from "../src/db/seq";
import { subscribeMany } from "../src/db/subscriptions";
import { createAccessToken } from "../src/db/tokens";
import type { Job } from "../src/jobs/job";
import type { Platform } from "../src/platform";
import { TEST_TOKEN as API_TOKEN, TEST_USER } from "./fixtures/user";

export { API_TOKEN, TEST_USER };

/**
 * D1 に投げたクエリの数を数える。D1 は 1 回の実行で投げられるクエリの数に上限があるので、
 * 最悪の場合でも収まるかをテストで確かめるのに使う。
 */
function countingD1(db: D1Database) {
  const counter = { queries: 0 };
  const wrapped = new Proxy(db, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== "function") return value;
      if (prop === "prepare" || prop === "exec" || prop === "batch") {
        return (...args: unknown[]) => {
          counter.queries++;
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return value.bind(target);
    },
  });
  return { db: wrapped, counter };
}

/** テスト用の Platform。DB は本物の D1（手元の Miniflare）、キューと fetch は差し替える */
export function createTestPlatform(overrides: Partial<Platform> = {}) {
  const enqueued: Job[] = [];
  const d1 = countingD1(env.DB);
  const platform: Platform = {
    db: drizzle(d1.db, { schema }),
    jobs: {
      async enqueue(jobs) {
        enqueued.push(...jobs);
      },
    },
    fetch: async () => {
      throw new Error("network access is not allowed in tests; pass a fake fetch");
    },
    now: () => new Date(),
    ...overrides,
  };
  return {
    platform,
    enqueued,
    /** これまでに D1 に投げたクエリの数 */
    queryCount: () => d1.counter.queries,
    resetQueryCount: () => {
      d1.counter.queries = 0;
    },
  };
}

/** アプリにリクエストを送る。既定で認証のヘッダーを付ける */
export function requestApp(
  platform: Platform,
  path: string,
  init: RequestInit & { json?: unknown; token?: string | null } = {},
) {
  const { json, token = API_TOKEN, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  if (json !== undefined) headers.set("content-type", "application/json");
  return createApp(platform).request(path, {
    ...rest,
    headers,
    ...(json !== undefined && { body: JSON.stringify(json) }),
  });
}

/** 決まった応答を返す fetch。呼ばれた URL とヘッダーを記録する */
export function fakeFetch(
  respond: (url: URL, init: RequestInit | undefined) => Response | Promise<Response>,
) {
  const calls: { url: string; headers: Headers }[] = [];
  const fn: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push({ url: url.href, headers: new Headers(init?.headers) });
    return respond(url, init);
  };
  return { fetch: fn, calls };
}

/** テストごとに重ならない URL を作る（D1 はテストファイルの中で共有されるため） */
export function uniqueUrl(path = "feed.xml"): string {
  return `https://${crypto.randomUUID()}.example.com/${path}`;
}

/** テスト用のユーザーをもう 1 人作り、そのアクセストークンを返す */
export async function createUser(email = `${crypto.randomUUID()}@example.com`) {
  const { platform } = createTestPlatform();
  const id = crypto.randomUUID();
  await platform.db.insert(schema.users).values({ id, email, createdAt: new Date() }).run();
  const { token } = await createAccessToken(platform.db, {
    userId: id,
    name: "test",
    now: new Date(),
  });
  return { id, email, token };
}

/** フィード（共有）を作り、ユーザーに購読させる。フィード（共有）がすでにあれば、それを使う */
export async function subscribeFeed(
  platform: Platform,
  input: { url?: string; feedId?: string; userId?: string; folderId?: string | null; now?: Date },
) {
  const now = input.now ?? new Date();
  const { feed } = await insertFeed(platform.db, {
    id: input.feedId ?? crypto.randomUUID(),
    url: input.url ?? uniqueUrl(),
    now,
  });
  await subscribeMany(platform.db, {
    userId: input.userId ?? TEST_USER.id,
    rows: [{ feedId: feed.id, folderId: input.folderId ?? null }],
    now,
  });
  return feed;
}

/** 受信箱に記事を入れる。受信箱に入った時刻（receivedAt）を決めて入れたいときに使う */
export async function addToInbox(
  platform: Platform,
  rows: readonly {
    articleId: string;
    feedId: string;
    publishedAt: Date;
    receivedAt: Date;
    userId?: string;
  }[],
) {
  for (const row of rows) {
    await platform.db
      .insert(schema.userArticles)
      .values({
        userId: row.userId ?? TEST_USER.id,
        articleId: row.articleId,
        feedId: row.feedId,
        publishedAt: row.publishedAt,
        createdAt: row.receivedAt,
        seq: nextSeq(schema.userArticles),
        readSeq: nextSeq(schema.userArticles),
      })
      .run();
  }
}
