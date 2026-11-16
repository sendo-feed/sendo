import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type OpenedDatabase, openDatabase } from "../../src/platform/node/database";

export const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations", import.meta.url));

/**
 * テスト用に、一時ディレクトリの SQLite を開き、本番と同じマイグレーションを当てる。
 * cleanup で閉じて消す
 */
export async function openTestDatabase(): Promise<
  OpenedDatabase & { directory: string; cleanup(): Promise<void> }
> {
  const directory = await mkdtemp(path.join(tmpdir(), "sendo-db-"));
  const database = await openDatabase(`file:${path.join(directory, "sendo.db")}`, {
    migrationsFolder: MIGRATIONS_DIR,
  });
  return {
    ...database,
    directory,
    async cleanup() {
      database.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

/** pnpm build:native が作るモジュール（pnpm check はテストの前に作る） */
export const NATIVE_MODULE = fileURLToPath(new URL("../../native/sendo.node", import.meta.url));

/** Readability が本文だと判断できる、ある程度の長さのページ */
export function articlePage(options: { charsetMeta?: string; script?: boolean } = {}): string {
  const paragraphs = Array.from(
    { length: 8 },
    (_, i) =>
      `<p>これは記事の本文の段落 ${i} です。本文だと判断できるように、ある程度の長さの文章を、いくつかの段落に分けて書いておきます。<a href="/related/${i}">関連</a></p>`,
  ).join("");
  return [
    "<!doctype html><html><head>",
    options.charsetMeta ? `<meta charset="${options.charsetMeta}">` : "",
    "<title>見出し | サイト</title></head><body><nav>メニュー</nav><article><h1>見出し</h1>",
    paragraphs,
    options.script ? "<script>alert(1)</script><img src=x onerror=alert(1)>" : "",
    "</article><footer>フッター</footer></body></html>",
  ].join("");
}
