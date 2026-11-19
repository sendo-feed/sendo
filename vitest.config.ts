import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // テストファイルごとに、一時ディレクトリの SQLite を開いて閉じる（test/db.ts）
    setupFiles: ["./test/setup.ts"],
  },
});
