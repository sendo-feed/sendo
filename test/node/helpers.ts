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
