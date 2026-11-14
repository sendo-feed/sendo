import type { D1Migration } from "@cloudflare/vitest-plugin";

declare global {
  namespace Cloudflare {
    interface Env {
      /** vitest.config.ts で渡す、D1 のマイグレーション */
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
