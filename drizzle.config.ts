import { defineConfig } from "drizzle-kit";

// マイグレーションの SQL を、スキーマ（src/db/schema.ts）から作る。
// 作った SQL は、起動したときに当てる（src/platform/node/database.ts）。
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./migrations",
});
