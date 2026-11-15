#!/usr/bin/env node
/**
 * デプロイする（docs/decisions/deploy.md の 2）。Workers Builds のデプロイのコマンド
 * （pnpm run deploy）からも、手元からも使う。
 *
 * - D1 があれば、マイグレーションを当ててから、デプロイする
 * - D1 がまだなければ（初めてのデプロイ）、先にデプロイして、Wrangler に D1 と Queues を作らせる。
 *   それからマイグレーションを当てて、もう一度デプロイする。マイグレーションのコマンドは、
 *   D1 を名前で探すだけで、なければ作らずに止まるため
 *
 * 秘密（wrangler.jsonc の secrets.required）をまだ入れていなければ、初めてのデプロイは止まる。
 * - Cloudflare の画面からリポジトリをつないだ（Workers Builds）なら、Worker はもうあり、D1 と Queues を
 *   作ったあとで止まる。画面で秘密を入れて、もう一度動かす
 * - 手元から初めてデプロイするなら、Worker がまだないので、D1 を作る前に止まる（wrangler secret put も
 *   使えない）。--secrets-file で秘密を渡す。渡したファイルは、wrangler deploy にそのまま渡す
 *
 *   pnpm run deploy [--secrets-file <秘密のファイル>] [--config <wrangler の設定ファイル>]
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { parseArgs } from "node:util";
import { unstable_readConfig } from "wrangler";

const { values } = parseArgs({
  options: {
    "secrets-file": { type: "string" },
    config: { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (values.help) {
  console.log(
    "使い方: pnpm run deploy [--secrets-file <秘密のファイル>] [--config <wrangler の設定ファイル>]",
  );
  process.exit(0);
}

const configArgs = values.config ? ["--config", values.config] : [];
const secretsArgs = values["secrets-file"] ? ["--secrets-file", values["secrets-file"]] : [];
const config = unstable_readConfig(values.config ? { config: values.config } : {});
const database = config.d1_databases.find((d) => d.binding === "DB");
if (!database?.database_name) {
  console.error("wrangler の設定に、DB という名前で結んだ D1（database_name 付き）がない。");
  process.exit(1);
}

// シェルを介さずに wrangler を呼ぶ（Windows でも同じに動くように）
const require = createRequire(import.meta.url);
const wranglerBin = path.join(
  path.dirname(require.resolve("wrangler/package.json")),
  "bin",
  "wrangler.js",
);

/** wrangler を動かす。失敗したら、その終了コードで止まる */
function wrangler(args, { onError } = {}) {
  try {
    execFileSync(process.execPath, [wranglerBin, ...args, ...configArgs], { stdio: "inherit" });
  } catch (error) {
    if (onError) console.error(`\n${onError}`);
    process.exit(typeof error.status === "number" && error.status !== 0 ? error.status : 1);
  }
}

/** アカウントに、設定の名前の D1 があるか。database_id を書いてあれば、あるものとして扱う */
function databaseExists() {
  if (database.database_id) return true;
  try {
    const output = execFileSync(
      process.execPath,
      [wranglerBin, "d1", "list", "--json", ...configArgs],
      { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
    );
    return JSON.parse(output).some((d) => d.name === database.database_name);
  } catch (error) {
    console.error(`\nD1 の一覧を読めなかった：${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}

if (!databaseExists()) {
  console.log(
    `D1（${database.database_name}）がまだないので、先にデプロイして、D1 と Queues を作る（初めてのデプロイ）。\n`,
  );
  wrangler(["deploy", ...secretsArgs], {
    onError:
      "デプロイが止まった。必須の秘密（wrangler.jsonc の secrets.required）がないなら、入れてから、もう一度\n" +
      "デプロイする（README の「デプロイ」）。\n" +
      "- Cloudflare の画面からつないだなら：Worker の「変数とシークレット」に、型を「シークレット」にして入れる\n" +
      "- 手元から初めてデプロイするなら：pnpm run deploy --secrets-file <ファイル> で渡す（1 行に 名前=値）",
  });
}

wrangler(["d1", "migrations", "apply", database.binding, "--remote"]);
wrangler(["deploy", ...secretsArgs]);
