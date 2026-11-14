import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { hashToken } from "../src/db/tokens";
import { TEST_TOKEN, TEST_USER } from "./fixtures/user";

// 本番と同じマイグレーションを当ててからテストする。すでに当たっていれば何もしない
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// API のテストで使うユーザーとアクセストークン
await env.DB.batch([
  env.DB.prepare("INSERT OR IGNORE INTO users (id, email, created_at) VALUES (?, ?, ?)").bind(
    TEST_USER.id,
    TEST_USER.email,
    0,
  ),
  env.DB.prepare(
    "INSERT OR IGNORE INTO access_tokens (id, user_id, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?)",
  ).bind("test-token", TEST_USER.id, "test", await hashToken(TEST_TOKEN), 0),
]);
