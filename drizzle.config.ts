import { defineConfig } from "drizzle-kit";

// マイグレーションの SQL を、スキーマ（src/db/schema.ts）から作る。
// 作った SQL は wrangler d1 migrations apply で当てる（D1 のマイグレーションの仕組みを使う）。
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./migrations",
});
