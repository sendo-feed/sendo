#!/usr/bin/env node
/**
 * 手元で Sendo を動かす。ソース（src/platform/node/main.ts）を tsx でそのまま動かす。
 *
 *   pnpm dev                                サーバーを動かす（変更を見て動かし直す）
 *   pnpm token:create --email <メール>       手元の DB に、アクセストークンを発行する
 *
 * .env があれば読む（.env.example を写して書く）。データは .data/ に置き、マイグレーションは起動時に
 * 当てる。Rust のネイティブのモジュール（native/sendo.node）は、先に pnpm build:native で作っておく。
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const envFile = path.join(root, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const nativeModule = process.env.NATIVE_MODULE || path.join(root, "native/sendo.node");
if (!existsSync(nativeModule)) {
  console.error(`ネイティブのモジュールがない: ${nativeModule}\n先に pnpm build:native を実行する`);
  process.exit(1);
}

const embeddingModel =
  process.env.EMBEDDING_MODEL_DIR || path.join(root, "models/potion-multilingual-128m");
if (process.argv.length <= 2) {
  // 用意したモデルが、固定ファイルの版と合っているかを確かめる（古い版のベクトルを書かないため）
  const lock = JSON.parse(
    readFileSync(path.join(root, "models/potion-multilingual-128m.json"), "utf8"),
  );
  const marker = path.join(embeddingModel, ".prepared.json");
  const prepared = existsSync(marker) ? JSON.parse(readFileSync(marker, "utf8")) : null;
  if (prepared?.converted !== lock.converted["model.safetensors"]) {
    console.error(
      `埋め込みのモデルがないか、版が古い: ${embeddingModel}\n先に pnpm model:prepare を実行する`,
    );
    process.exit(1);
  }
}

const env = {
  ...process.env,
  DATA_DIR: process.env.DATA_DIR || path.join(root, ".data"),
  MIGRATIONS_DIR: process.env.MIGRATIONS_DIR || path.join(root, "migrations"),
  NATIVE_MODULE: nativeModule,
  EMBEDDING_MODEL_DIR: embeddingModel,
};

const args = process.argv.slice(2);
const main = path.join(root, "src/platform/node/main.ts");
// サーバーは変更を見て動かし直す。コマンド（token:create など）は 1 回だけ動かす
const tsxArgs = args.length === 0 ? ["watch", main] : [main, ...args];
const child = spawn(path.join(root, "node_modules/.bin/tsx"), tsxArgs, {
  cwd: root,
  env,
  stdio: "inherit",
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
