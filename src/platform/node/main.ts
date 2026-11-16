/**
 * コンテナ版の入口（docs/decisions/container.md）。Cloudflare 版の src/index.ts に当たる。
 * 設定から実装を組み立てて渡すだけにし、処理の中身は書かない。
 *
 *   node dist/node/sendo.mjs                     サーバーを動かす（既定）
 *   node dist/node/sendo.mjs token:create ...    アクセストークンを発行する
 *
 * 設定は環境変数で受ける。名前は Cloudflare 版と同じ（ALLOWED_EMAILS、PUBLIC_URL など）。
 * コンテナ版だけのものは、PORT（既定 8787）、DATA_DIR（既定 /data）、MIGRATIONS_DIR、NATIVE_MODULE。
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { serve } from "@hono/node-server";
import { createApp } from "../../app";
import { runJob } from "../../jobs";
import { runScheduled } from "../../jobs/schedule";
import { parseOrigin } from "..";
import { openDatabase } from "./database";
import { createNodePlatform, dataDirectory, type NodeEnv, withPublicOrigin } from "./index";
import { createSqliteJobQueue } from "./job-queue";
import { createPageContentExtractor, loadNativeModule } from "./native";
import { startScheduler } from "./scheduler";
import { createTokenForEmail } from "./token";

/** 止めるときに、動いている仕事を待つ上限 */
const SHUTDOWN_TIMEOUT_MS = 30 * 1000;

/** ネイティブのモジュール（Rust）の置き場。既定は、バンドル（dist/node/sendo.mjs）から見た ../../native */
function nativeModulePath(env: NodeEnv): string {
  return (
    env.NATIVE_MODULE?.trim() || fileURLToPath(new URL("../../native/sendo.node", import.meta.url))
  );
}

/**
 * Rust の処理を読み込み、記事のページから本文を抜く実装を作る。読み込めなければ、ログに出して
 * その機能なしで動く（GET /api/v1/features が false を返す）。イメージには必ず入っている
 */
function loadPageContentExtractor(env: NodeEnv) {
  const file = nativeModulePath(env);
  try {
    return createPageContentExtractor(loadNativeModule(file));
  } catch (error) {
    console.error("could not load the native module; page content is disabled", { file, error });
    return undefined;
  }
}

/** マイグレーションの置き場。既定は、バンドル（dist/node/sendo.mjs）から見た ../../migrations */
function migrationsDirectory(env: NodeEnv): string {
  return env.MIGRATIONS_DIR?.trim() || fileURLToPath(new URL("../../migrations", import.meta.url));
}

/** データのディレクトリを作り、DB を開いて、マイグレーションを当てる */
async function prepareDatabase(env: NodeEnv) {
  const directory = dataDirectory(env);
  await mkdir(directory, { recursive: true });
  return openDatabase(`file:${path.join(directory, "sendo.db")}`, {
    migrationsFolder: migrationsDirectory(env),
  });
}

function readPort(env: NodeEnv): number {
  const text = env.PORT?.trim() || "8787";
  const port = Number(text);
  if (!/^\d+$/.test(text) || port < 1 || port > 65535)
    throw new RangeError(`invalid PORT: ${text}`);
  return port;
}

/** OAuth の設定と同じく、形が正しくなければ使わない（ログに出す） */
function readPublicOrigin(env: NodeEnv): string | undefined {
  try {
    return parseOrigin(env.PUBLIC_URL);
  } catch (error) {
    console.error("PUBLIC_URL is ignored: it must be an https origin", error);
    return undefined;
  }
}

async function runServer(env: NodeEnv): Promise<void> {
  const port = readPort(env);
  const database = await prepareDatabase(env);
  const jobs = createSqliteJobQueue(database.db);
  const platform = createNodePlatform({
    env,
    db: database.db,
    jobs,
    pageContent: loadPageContentExtractor(env),
  });
  const app = createApp(platform);

  jobs.start((job) => runJob(platform, job));
  const scheduler = startScheduler((scheduledTime) => runScheduled(platform, scheduledTime));
  const server = serve(
    {
      fetch: withPublicOrigin((request) => app.fetch(request), readPublicOrigin(env)),
      port,
      hostname: env.HOST?.trim() || "0.0.0.0",
    },
    (info) => console.info("sendo is listening", { address: info.address, port: info.port }),
  );

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.info("shutting down", { signal });
    const timeout = setTimeout(() => {
      console.error("shutdown timed out; exiting");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    // 新しい接続を受けるのをやめ、処理中のリクエストが終わるのを待つ。待っている間の、使われていない
    // 接続（keep-alive）は閉じる。終わらなければ、上の上限で打ち切る
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    if ("closeIdleConnections" in server) server.closeIdleConnections();
    await closed;
    await scheduler.stop();
    await jobs.stop();
    database.close();
    clearTimeout(timeout);
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

const TOKEN_USAGE = `使い方: node dist/node/sendo.mjs token:create --email <メールアドレス> [--name <用途の名前>] [--mcp [--write]]

  --email   トークンを持つユーザーのメールアドレス。いなければ作る
  --name    トークンの用途の名前（例：Reeder、CLI）。既定は CLI
  --mcp     MCP 用（/mcp でだけ使える）にする。付けなければリーダーアプリと REST API 用
  --write   MCP 用のトークンに、状態を変えるツール（購読、既読、スターなど）も許す。付けなければ読むだけ`;

async function runTokenCreate(env: NodeEnv, args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      email: { type: "string" },
      name: { type: "string", default: "CLI" },
      mcp: { type: "boolean", default: false },
      write: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help || values.email === undefined) {
    console.log(TOKEN_USAGE);
    process.exitCode = values.help ? 0 : 1;
    return;
  }
  const database = await prepareDatabase(env);
  try {
    const token = await createTokenForEmail(
      database.db,
      { email: values.email, name: values.name, mcp: values.mcp, write: values.write },
      new Date(),
    );
    console.log(token);
  } finally {
    database.close();
  }
}

async function main(argv: string[]): Promise<void> {
  const [command = "serve", ...args] = argv;
  switch (command) {
    case "serve":
      return runServer(process.env);
    case "token:create":
      return runTokenCreate(process.env, args);
    default:
      console.error(`unknown command: ${command}（serve か token:create）`);
      process.exitCode = 1;
  }
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
