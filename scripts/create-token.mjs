#!/usr/bin/env node
/**
 * アクセストークンを発行する。ユーザーがいなければ作る。
 *
 * ブラウザでログインせずにトークンを発行するときに使う（ふだんは、ログインして /api/v1/tokens で
 * 発行する）。D1 に直接書くので、そのデプロイ先の D1 を操作できる人（管理者）だけが使える。
 *
 *   pnpm token:create --email you@example.com [--name CLI] [--remote]
 *
 * トークンの形とハッシュは src/db/tokens.ts と同じにすること。
 */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    email: { type: "string" },
    name: { type: "string", default: "CLI" },
    remote: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (values.help || !values.email) {
  console.log(`使い方: pnpm token:create --email <メールアドレス> [--name <用途の名前>] [--remote]

  --email   トークンを持つユーザーのメールアドレス。いなければ作る
  --name    トークンの用途の名前（例：Reeder、CLI）。既定は CLI
  --remote  デプロイ先の D1 に書く。付けなければ手元の D1（pnpm dev で使うもの）に書く`);
  process.exit(values.help ? 0 : 1);
}

const email = values.email.trim().toLowerCase();
if (!/^[^\s@'"\\]+@[^\s@'"\\]+\.[^\s@'"\\]+$/.test(email)) {
  console.error(`メールアドレスの形が正しくない: ${values.email}`);
  process.exit(1);
}
const name = values.name.trim();
if (name === "" || name.length > 100) {
  console.error("--name は 1〜100 文字で指定する");
  process.exit(1);
}

const token = `sendo_${randomBytes(32).toString("base64url")}`;
const tokenHash = createHash("sha256").update(token).digest("hex");
const now = Date.now();

/** SQL の文字列リテラルにする（' を '' にする） */
const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;

const sql = [
  `INSERT INTO users (id, email, created_at) VALUES (${literal(randomUUID())}, ${literal(email)}, ${now}) ON CONFLICT(email) DO NOTHING;`,
  `INSERT INTO access_tokens (id, user_id, name, token_hash, created_at) SELECT ${literal(randomUUID())}, id, ${literal(name)}, ${literal(tokenHash)}, ${now} FROM users WHERE email = ${literal(email)};`,
].join(" ");

// シェルを介さずに wrangler を呼ぶ（Windows でも同じに動くように）
const require = createRequire(import.meta.url);
const wrangler = path.join(
  path.dirname(require.resolve("wrangler/package.json")),
  "bin",
  "wrangler.js",
);

try {
  execFileSync(
    process.execPath,
    [wrangler, "d1", "execute", "DB", values.remote ? "--remote" : "--local", "--command", sql],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
} catch {
  console.error(
    "\nD1 に書けなかった。手元なら、先に pnpm db:migrate:local でテーブルを作ったか確かめる。",
  );
  process.exit(1);
}

console.log(`アクセストークンを発行した（ユーザー: ${email}、用途: ${name}）。
このトークンは二度と表示しない。安全な場所に控えておくこと。

  ${token}
`);
