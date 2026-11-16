/**
 * 設定を読む。2 つの版で同じ名前の設定を使うので（docs/decisions/container.md の 11）、読み方もここで
 * 共有する。Cloudflare 版は env（画面の変数とシークレット）から、コンテナ版は環境変数から渡す。
 */
import {
  type AuthConfig,
  DEFAULT_ARTICLE_RETENTION_DAYS,
  DEFAULT_FETCH_INTERVAL_MINUTES,
  type FetchConfig,
  MIN_ARTICLE_RETENTION_DAYS,
  MIN_FETCH_INTERVAL_MINUTES,
  type OAuthServerConfig,
  parseArticleRetentionDays,
  parseEmailList,
  parseFetchIntervalMinutes,
  parseOrigin,
  type RetentionConfig,
} from ".";

/**
 * 取得の設定を読む（docs/decisions/jobs.md の 6）。なければ既定。形が正しくなければ、
 * エラーをログに出して既定を使う
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
 * 古い記事の片付けの設定を読む（docs/decisions/retention.md の 1）。読み方は readFetchConfig と同じ
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

/** 認証の設定に使う名前 */
export type AuthEnvName =
  | "ALLOWED_EMAILS"
  | "GOOGLE_CLIENT_ID"
  | "GOOGLE_CLIENT_SECRET"
  | "PUBLIC_URL"
  | "READER_URL";

/**
 * ログインの設定を読む。秘密（メール、Google のクライアント）がなければ、ブラウザのログインは
 * 使えない（アクセストークンだけで使う）。
 *
 * OAuth（PUBLIC_URL と READER_URL）は、2 つともあるときだけ使う。形が正しくなければ、
 * エラーをログに出して OAuth を使わない
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
