import path from "node:path";
import type { Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { createApp } from "../src/app";
import type { Database } from "../src/db";
import { insertFeed } from "../src/db/feeds";
import * as schema from "../src/db/schema";
import { nextSeq } from "../src/db/seq";
import { createSession } from "../src/db/sessions";
import { subscribeMany } from "../src/db/subscriptions";
import { createAccessToken } from "../src/db/tokens";
import type { Job } from "../src/jobs/job";
import {
  DEFAULT_FETCH_INTERVAL_MINUTES,
  DEFAULT_STORAGE_LIMIT_MIB,
  type LanguageDetector,
  type PageContentExtractor,
  type Platform,
  type SyncUpdates,
} from "../src/platform";
import { createFileObjectStore } from "../src/platform/node/file-store";
import { createSqliteArticleSearch } from "../src/platform/sqlite/article-search";
import { testDatabase } from "./db";
import { TEST_TOKEN as API_TOKEN, TEST_USER } from "./fixtures/user";

export { API_TOKEN, TEST_USER };

/** libsql のクライアントが SQL を実行する入口。drizzle はこれらを通して文を投げる */
const EXECUTE_METHODS = new Set(["execute", "batch", "executeMultiple", "migrate"]);

/**
 * libsql のクライアントを包み、SQL を実行する直前に onExecute を呼ぶ。onExecute には実行する SQL を
 * 渡す（batch などは、まとめて 1 回）
 */
function wrapClient(client: Client, onExecute: (sql: string) => void | Promise<void>): Client {
  return new Proxy(client, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== "function") return value;
      if (typeof prop === "string" && EXECUTE_METHODS.has(prop)) {
        return async (...args: unknown[]) => {
          const [statement] = args;
          const sql =
            typeof statement === "string"
              ? statement
              : typeof statement === "object" && statement !== null && "sql" in statement
                ? String(statement.sql)
                : "";
          await onExecute(sql);
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return value.bind(target);
    },
  });
}

/** 包んだクライアントで、アプリが使うのと同じ形の DB を作る */
function databaseOf(client: Client): Database {
  return drizzle(client, { schema });
}

/** テストで呼ばれたら失敗させる、ページの本文の抜き取り。使うテストは差し替える */
const unusedPageContent: PageContentExtractor = {
  async extract() {
    throw new Error("page content extraction is not set up in this test; pass pageContent");
  },
};

/** テストで呼ばれたら失敗させる、言語の判定。使うテストは差し替える */
const unusedLanguageDetection: LanguageDetector = {
  detector: "unused",
  pipelineRevision: 1,
  async detect() {
    throw new Error("language detection is not set up in this test; pass languageDetection");
  },
};

/** Rust の処理を使わないテストで、Platform に渡すもの（呼ばれたら失敗する） */
export const unusedNative = {
  pageContent: unusedPageContent,
  languageDetection: unusedLanguageDetection,
};

/** 実際の HTTP 接続を使わないテストの通知。 */
export const unusedSyncUpdates: SyncUpdates = {
  async connect() {
    throw new Error("WebSocket server is not set up in this test");
  },
  async notify() {},
};

/** 知らせを受けた利用者を記録する通知。知らせる範囲（docs/decisions/sync.md の 9）を確かめるのに使う */
export function recordingSyncUpdates() {
  const notified: string[] = [];
  const syncUpdates: SyncUpdates = {
    ...unusedSyncUpdates,
    async notify(userIds) {
      notified.push(...userIds);
    },
  };
  return { syncUpdates, notified };
}

/** テスト用の Platform。DB はテストファイルの SQLite（test/db.ts）、キューと fetch は差し替える */
export function createTestPlatform(overrides: Partial<Platform> = {}) {
  const enqueued: Job[] = [];
  const counter = { queries: 0 };
  const db =
    overrides.db ??
    databaseOf(
      wrapClient(testDatabase.client, () => {
        counter.queries++;
      }),
    );
  const platform: Platform = {
    syncUpdates: unusedSyncUpdates,
    db,
    articleSearch: createSqliteArticleSearch(db),
    jobs: {
      async enqueueDueDiscordFetches() {
        return 0;
      },
      async enqueue(jobs) {
        enqueued.push(...jobs);
      },
    },
    content: createFileObjectStore(path.join(testDatabase.directory, "content")),
    fetch: async () => {
      throw new Error("network access is not allowed in tests; pass a fake fetch");
    },
    now: () => new Date(),
    auth: { allowedEmails: new Set(), google: undefined, oauth: undefined },
    fetchConfig: { intervalMs: DEFAULT_FETCH_INTERVAL_MINUTES * 60 * 1000 },
    retentionConfig: { maxBytes: DEFAULT_STORAGE_LIMIT_MIB * 1024 * 1024 },
    pageContent: unusedPageContent,
    languageDetection: unusedLanguageDetection,
    ...overrides,
  };
  return {
    platform,
    enqueued,
    /** これまでに DB に投げた文の数 */
    queryCount: () => counter.queries,
    resetQueryCount: () => {
      counter.queries = 0;
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
    // 本物の fetch と同じように Request を組み立てる。受け付けない指定は、ここで本番と同じ
    // TypeError になる
    new Request(input, init);
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push({ url: url.href, headers: new Headers(init?.headers) });
    return respond(url, init);
  };
  return { fetch: fn, calls };
}

/** テストごとに重ならない URL を作る（DB はテストファイルの中で共有されるため） */
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

/**
 * ユーザーのセッションを作り、ブラウザが送るのと同じヘッダー（クッキーと、同じオリジンの印）を返す。
 * Google のログインを通さずに、セッションで認証した API を試すのに使う
 */
export async function createSessionHeaders(userId: string) {
  const { platform } = createTestPlatform();
  const { token } = await createSession(platform.db, { userId, now: new Date() });
  return { cookie: `__Host-sendo_session=${token}`, "sec-fetch-site": "same-origin" };
}

/**
 * 条件に合う文を実行する直前に、一度だけ before を実行する DB。ほかのリクエストが間に入る場合や、
 * 途中で落ちる場合（before で投げる）をまねる。armed を false にすると、arm を呼ぶまで待つ
 */
export function statementHook(
  match: RegExp | ((sql: string) => boolean),
  before: () => Promise<void>,
  options: { armed?: boolean } = {},
) {
  let armed = options.armed ?? true;
  let fired = false;
  const test = typeof match === "function" ? match : (sql: string) => match.test(sql);
  const db = databaseOf(
    wrapClient(testDatabase.client, async (sql) => {
      if (!armed || !test(sql)) return;
      armed = false;
      fired = true;
      await before();
    }),
  );
  return {
    db,
    fired: () => fired,
    arm: () => {
      armed = true;
    },
  };
}
