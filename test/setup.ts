import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

// 本番と同じマイグレーションを当ててからテストする。すでに当たっていれば何もしない
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
