import { drizzle } from "drizzle-orm/d1";
import * as schema from "../../db/schema";
import {
  type AuthConfig,
  DEFAULT_ARTICLE_RETENTION_DAYS,
  DEFAULT_FETCH_INTERVAL_MINUTES,
  type FetchConfig,
  MIN_ARTICLE_RETENTION_DAYS,
  MIN_FETCH_INTERVAL_MINUTES,
  type OAuthServerConfig,
  type Platform,
  parseArticleRetentionDays,
  parseEmailList,
  parseFetchIntervalMinutes,
  parseOrigin,
  type RetentionConfig,
} from "..";
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
    fetch: (input, init) => fetch(input, init),
    now: () => new Date(),
    auth: readAuthConfig(env),
    fetchConfig: readFetchConfig(env),
    retentionConfig: readRetentionConfig(env),
  };
}

/**
 * 取得の設定を env から読む（docs/decisions/jobs.md の 6）。秘密ではないので、Cloudflare の画面の
 * 変数に入れる。なければ既定。形が正しくなければ、エラーをログに出して既定を使う
 */
export function readFetchConfig(env: { FETCH_INTERVAL_MINUTES?: string }): FetchConfig {
  let minutes = DEFAULT_FETCH_INTERVAL_MINUTES;
  try {
    minutes = parseFetchIntervalMinutes(env.FETCH_INTERVAL_MINUTES) ?? minutes;
  } catch (error) {
    console.error(
      `FETCH_INTERVAL_MINUTES must be an integer of at least ${MIN_FETCH_INTERVAL_MINUTES}; using ${minutes}`,
      error,
    );
  }
  return { intervalMs: minutes * 60 * 1000 };
}

/**
 * 古い記事の片付けの設定を env から読む（docs/decisions/retention.md の 1）。読み方は
 * readFetchConfig と同じ
 */
export function readRetentionConfig(env: { ARTICLE_RETENTION_DAYS?: string }): RetentionConfig {
  let days = DEFAULT_ARTICLE_RETENTION_DAYS;
  try {
    days = parseArticleRetentionDays(env.ARTICLE_RETENTION_DAYS) ?? days;
  } catch (error) {
    console.error(
      `ARTICLE_RETENTION_DAYS must be an integer of at least ${MIN_ARTICLE_RETENTION_DAYS}; using ${days}`,
      error,
    );
  }
  return { articleMs: days * 24 * 60 * 60 * 1000 };
}

/** 認証の設定に使う env の名前 */
type AuthEnvName =
  | "ALLOWED_EMAILS"
  | "GOOGLE_CLIENT_ID"
  | "GOOGLE_CLIENT_SECRET"
  | "PUBLIC_URL"
  | "READER_URL";

/**
 * ログインの設定を env から読む。秘密（メール、Google のクライアント）は、手元では .dev.vars、
 * 本番は Cloudflare の画面のシークレットに入れる。設定していなければ、ブラウザのログインは使えない
 * （アクセストークンだけで使う）。
 *
 * OAuth（PUBLIC_URL と READER_URL）は秘密ではないので、Cloudflare の画面の変数に入れる。
 * 2 つともあるときだけ使う。形が正しくなければ、エラーをログに出して OAuth を使わない
 */
export function readAuthConfig(env: Partial<Record<AuthEnvName, string>>): AuthConfig {
  const clientId = env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  return {
    allowedEmails: parseEmailList(env.ALLOWED_EMAILS),
    google: clientId && clientSecret ? { clientId, clientSecret } : undefined,
    oauth: readOAuthServerConfig(env),
  };
}

function readOAuthServerConfig(
  env: Partial<Record<AuthEnvName, string>>,
): OAuthServerConfig | undefined {
  try {
    const issuer = parseOrigin(env.PUBLIC_URL);
    const readerOrigin = parseOrigin(env.READER_URL);
    return issuer && readerOrigin ? { issuer, readerOrigin } : undefined;
  } catch (error) {
    console.error("OAuth is disabled: PUBLIC_URL and READER_URL must be https origins", error);
    return undefined;
  }
}
