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
import { existsSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const envFile = path.join(root, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const nativeModule = process.env.NATIVE_MODULE || path.join(root, "native/sendo.node");
if (!existsSync(nativeModule)) {
  console.error(`ネイティブのモジュールがない: ${nativeModule}\n先に pnpm build:native を実行する`);
  process.exit(1);
}

const env = {
  ...process.env,
  DATA_DIR: process.env.DATA_DIR || path.join(root, ".data"),
  MIGRATIONS_DIR: process.env.MIGRATIONS_DIR || path.join(root, "migrations"),
  NATIVE_MODULE: nativeModule,
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
