import { drizzle } from "drizzle-orm/d1";
import * as schema from "../../db/schema";
import type { ObjectStore, Platform } from "..";
import { readAuthConfig, readFetchConfig, readRetentionConfig } from "../config";
import { createQueueJobQueue } from "./queue";

export { createQueueJobQueue, handleQueueBatch, type JobRunner } from "./queue";

/**
 * デプロイする人が、Cloudflare の画面の「変数」に入れる設定（docs/decisions/deploy.md の 4）。
 * wrangler.jsonc の vars に書かないので、wrangler types が作る Env には出てこない。
 * 入れていなければ、env にない
 */
type SettingName =
  | "FETCH_INTERVAL_MINUTES"
  | "ARTICLE_RETENTION_DAYS"
  | "PUBLIC_URL"
  | "READER_URL";

/** Cloudflare の env から、アプリが使う Platform を組み立てる */
export function createCloudflarePlatform(workerEnv: Env): Platform {
  const env: Env & Partial<Record<SettingName, string>> = workerEnv;
  return {
    db: drizzle(env.DB, { schema }),
    jobs: createQueueJobQueue(env.JOBS),
    content: createR2ObjectStore(env.CONTENT),
    fetch: (input, init) => fetch(input, init),
    now: () => new Date(),
    auth: readAuthConfig(env),
    fetchConfig: readFetchConfig(env),
    retentionConfig: readRetentionConfig(env),
  };
}

/** R2 のバケットを、オブジェクトの置き場として使う */
export function createR2ObjectStore(bucket: R2Bucket): ObjectStore {
  return {
    async put(key, text) {
      await bucket.put(key, text, { httpMetadata: { contentType: "text/html; charset=utf-8" } });
    },
    async get(key) {
      const object = await bucket.get(key);
      return object === null ? null : object.text();
    },
    async delete(keys) {
      if (keys.length > 0) await bucket.delete([...keys]);
    },
  };
}
