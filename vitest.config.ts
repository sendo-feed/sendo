import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      // 2 つの版で動く処理のテストは、Cloudflare 版の本番と同じ Workers ランタイム（workerd）の中で動かす
      {
        plugins: [
          cloudflareTest(async () => ({
            wrangler: { configPath: "./wrangler.jsonc" },
            miniflare: {
              bindings: {
                // test/setup.ts が、各テストファイルの前に D1 へ当てる
                TEST_MIGRATIONS: await readD1Migrations("./migrations"),
              },
            },
          })),
        ],
        test: {
          name: "workers",
          include: ["test/**/*.test.ts"],
          exclude: [...configDefaults.exclude, "test/node/**"],
          setupFiles: ["./test/setup.ts"],
        },
      },
      // コンテナ版の緩衝層のテストは、Node で動かす（docs/decisions/container.md の 12）
      {
        test: {
          name: "node",
          environment: "node",
          include: ["test/node/**/*.test.ts"],
        },
      },
    ],
  },
});
