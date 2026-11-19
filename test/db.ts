/**
 * テストの DB。テストファイルごとに、一時ディレクトリの SQLite を開き、本番と同じマイグレーションを
 * 当て、テスト用のユーザーとトークンを入れる（test/setup.ts が、ファイルの最後に閉じて消す）。
 *
 * testDb は、SQL をそのまま書いて読み書きするための小さな入口。アプリの処理を通さずに、行を
 * 作ったり確かめたりするのに使う。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Client, InValue } from "@libsql/client";
import { hashToken } from "../src/db/tokens";
import { type OpenedDatabase, openDatabase } from "../src/platform/node/database";
import { TEST_TOKEN, TEST_USER } from "./fixtures/user";

export const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));

/** pnpm build:native が作るモジュール（pnpm check はテストの前に作る） */
export const NATIVE_MODULE = fileURLToPath(new URL("../native/sendo.node", import.meta.url));

export type TestDatabase = OpenedDatabase & {
  client: Client;
  directory: string;
  cleanup(): Promise<void>;
};

/**
 * 一時ディレクトリの SQLite を開き、本番と同じマイグレーションを当てる。cleanup で閉じて消す
 */
export async function openTestDatabase(): Promise<TestDatabase> {
  const directory = await mkdtemp(path.join(tmpdir(), "sendo-db-"));
  const database = await openDatabase(`file:${path.join(directory, "sendo.db")}`, {
    migrationsFolder: MIGRATIONS_DIR,
  });
  return {
    ...database,
    // drizzle の libsql の DB は、$client にクライアントを持つ
    client: (database.db as unknown as { $client: Client }).$client,
    directory,
    async cleanup() {
      database.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

type Row = Record<string, unknown>;

/** 1 つの文。bind で変数を渡し、first ／ all ／ run で実行する */
export class TestStatement {
  constructor(
    private readonly client: Client,
    private readonly query: string,
    private readonly args: readonly unknown[] = [],
  ) {}

  bind(...args: unknown[]): TestStatement {
    return new TestStatement(this.client, this.query, args);
  }

  private async execute() {
    const result = await this.client.execute({ sql: this.query, args: this.args as InValue[] });
    const rows = result.rows.map((row) =>
      Object.fromEntries(result.columns.map((column, index) => [column, row[index]])),
    );
    return { rows, changes: result.rowsAffected };
  }

  /** 最初の行。なければ null。column を渡すと、その列の値 */
  async first<T = Row>(): Promise<T | null>;
  async first<T = unknown>(column: string): Promise<T | null>;
  async first<T>(column?: string): Promise<T | null> {
    const [row] = (await this.execute()).rows;
    if (row === undefined) return null;
    return (column === undefined ? row : (row[column] ?? null)) as T | null;
  }

  async all<T = Row>(): Promise<{ results: T[] }> {
    return { results: (await this.execute()).rows as T[] };
  }

  async run(): Promise<{ changes: number }> {
    return { changes: (await this.execute()).changes };
  }
}

/** SQL をそのまま書いて、テストの DB を読み書きする */
export interface TestDb {
  prepare(query: string): TestStatement;
  /** 文をいくつか（; で区切って）続けて実行する */
  exec(query: string): Promise<void>;
}

function createTestDb(client: Client): TestDb {
  return {
    prepare: (query) => new TestStatement(client, query),
    exec: (query) => client.executeMultiple(query),
  };
}

/** このテストファイルの DB */
export const testDatabase = await openTestDatabase();
export const testDb = createTestDb(testDatabase.client);

// API のテストで使うユーザーとアクセストークン
await testDb
  .prepare("INSERT OR IGNORE INTO users (id, email, created_at) VALUES (?, ?, ?)")
  .bind(TEST_USER.id, TEST_USER.email, 0)
  .run();
await testDb
  .prepare(
    "INSERT OR IGNORE INTO access_tokens (id, user_id, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?)",
  )
  .bind("test-token", TEST_USER.id, "test", await hashToken(TEST_TOKEN), 0)
  .run();
