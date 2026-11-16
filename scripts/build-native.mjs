#!/usr/bin/env node
/**
 * Rust の処理（crates/node）をビルドし、Node から読み込めるネイティブのモジュール
 * （native/sendo.node）にする（docs/decisions/tech-stack.md の 5）。コンテナ版と、そのテストで使う。
 *
 *   pnpm build:native [--target <Rust のターゲット>]
 *
 * --target を付けると、そのターゲット向けにクロスコンパイルする（イメージのビルドで、arm64 向けに使う）。
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { target: { type: "string" } } });
const root = path.resolve(import.meta.dirname, "..");
const targetArgs = values.target ? ["--target", values.target] : [];

execFileSync("cargo", ["build", "--release", "--locked", "-p", "sendo-node", ...targetArgs], {
  cwd: root,
  stdio: "inherit",
});

// cargo が作るライブラリの名前は、OS ごとに違う
const library =
  process.platform === "win32"
    ? "sendo_node.dll"
    : process.platform === "darwin"
      ? "libsendo_node.dylib"
      : "libsendo_node.so";
const built = path.join(root, "target", values.target ?? "", "release", library);
const output = path.join(root, "native", "sendo.node");
mkdirSync(path.dirname(output), { recursive: true });
copyFileSync(built, output);
console.log(`built ${path.relative(root, output)}`);
