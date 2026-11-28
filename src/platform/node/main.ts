/**
 * Sendo の入口（docs/decisions/container.md）。設定から実装を組み立てて渡すだけにし、処理の中身は
 * 書かない。
 *
 *   node dist/node/sendo.mjs                     サーバーを動かす（既定）
 *   node dist/node/sendo.mjs token:create ...    アクセストークンを発行する
 *
 * 設定は環境変数で受ける（ALLOWED_EMAILS、PUBLIC_URL など。.env.example）。動かし方の設定は、
 * PORT（既定 8787）、HOST（既定 0.0.0.0）、DATA_DIR（既定 /data）、MIGRATIONS_DIR、NATIVE_MODULE。
 */
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createApp } from "../../app";
import { runJob } from "../../jobs";
import { enqueueLanguageDetection, runScheduled } from "../../jobs/schedule";
import { parseOrigin } from "..";
import { openDatabase } from "./database";
import { startDiscordIngestion } from "./discord-ingestion";
import { createNodePlatform, dataDirectory, type NodeEnv, withPublicOrigin } from "./index";
import { createSqliteJobQueue } from "./job-queue";
import {
  createArticleAnalyzer,
  createLanguageDetector,
  createPageContentExtractor,
  loadNativeModule,
} from "./native";
import { startScheduler } from "./scheduler";
import { createNodeServer } from "./server";
import { createNodeSyncUpdates } from "./sync-updates";
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
 * 埋め込みのモデル（pnpm model:prepare で用意する。イメージでは /app/models/...）の置き場。既定は、
 * バンドル（dist/node/sendo.mjs）から見た ../../models/potion-multilingual-128m
 */
function embeddingModelDirectory(env: NodeEnv): string {
  return (
    env.EMBEDDING_MODEL_DIR?.trim() ||
    fileURLToPath(new URL("../../models/potion-multilingual-128m", import.meta.url))
  );
}

/** 埋め込みのモデルのファイルを読む。Rust の側はファイルを読まない（docs/decisions/article-analysis.md の 6） */
async function readEmbeddingModel(env: NodeEnv) {
  const directory = embeddingModelDirectory(env);
  try {
    const read = (name: string) => readFile(path.join(directory, name));
    const [tokenizer, model, config] = await Promise.all([
      read("tokenizer.json"),
      read("model.safetensors"),
      read("config.json"),
    ]);
    return { tokenizer, model, config };
  } catch (error) {
    throw new Error(`could not read the embedding model: ${directory}`, { cause: error });
  }
}

/**
 * Rust の処理を読み込み、記事のページから本文を抜く実装、言語を調べる実装、記事を解析する実装を
 * 作る。イメージには必ず入っているので、読み込めなければ起動を止める（docs/decisions/container.md の 2）
 */
async function loadNativeFeatures(env: NodeEnv) {
  const file = nativeModulePath(env);
  let native: ReturnType<typeof loadNativeModule>;
  try {
    native = loadNativeModule(file);
  } catch (error) {
    throw new Error(`could not load the native module: ${file}`, { cause: error });
  }
  const files = await readEmbeddingModel(env);
  let articleAnalysis: Awaited<ReturnType<typeof createArticleAnalyzer>>;
  try {
    articleAnalysis = await createArticleAnalyzer(native, files);
  } catch (error) {
    throw new Error("could not load the embedding model", { cause: error });
  }
  return {
    pageContent: createPageContentExtractor(native),
    languageDetection: createLanguageDetector(native),
    articleAnalysis,
  };
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

/** 未設定は undefined、不正な設定は null。通知接続では不正な値を拒否する。 */
function readPublicOrigin(env: NodeEnv): string | null | undefined {
  try {
    return parseOrigin(env.PUBLIC_URL);
  } catch (error) {
    console.error("PUBLIC_URL is ignored: it must be an https origin", error);
    return null;
  }
}

async function runServer(env: NodeEnv): Promise<void> {
  const port = readPort(env);
  const native = await loadNativeFeatures(env);
  const database = await prepareDatabase(env);
  const jobs = createSqliteJobQueue(database.db);
  const publicOrigin = readPublicOrigin(env);
  const sync = createNodeSyncUpdates(database.db, { invalidPublicOrigin: publicOrigin === null });
  const platform = createNodePlatform({
    env,
    db: database.db,
    jobs,
    syncUpdates: sync.updates,
    ...native,
  });
  const app = createApp(platform);

  jobs.start((job) => runJob(platform, job));
  const discord = startDiscordIngestion(platform);
  await enqueueLanguageDetection(platform);
  const scheduler = startScheduler((scheduledTime) => runScheduled(platform, scheduledTime));
  const hostname = env.HOST?.trim() || "0.0.0.0";
  const server = createNodeServer(
    withPublicOrigin(app.fetch, publicOrigin ?? undefined),
    sync.webSocketServer,
    hostname,
  );
  server.listen(port, hostname, () => {
    const info = server.address();
    if (info && typeof info !== "string") {
      console.info("sendo is listening", { address: info.address, port: info.port });
    }
  });

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
    const notificationsClosed = sync.stop();
    server.closeIdleConnections();
    await Promise.all([closed, notificationsClosed, discord?.stop()]);
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
  --name    トークンの用途の名前（例：CLI、Claude Code）。既定は CLI
  --mcp     MCP 用（/mcp でだけ使える）にする。付けなければREST API 用
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
  if (error instanceof Error && error.cause !== undefined) console.error(error.cause);
  process.exit(1);
});
