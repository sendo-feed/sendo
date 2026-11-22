import { DISCORD_CALLBACK_PATH } from "../discord/client";
/**
 * 設定を読む（docs/decisions/container.md の 11）。環境変数から、値の入っているものだけを渡す。
 */
import {
  type AuthConfig,
  DEFAULT_FETCH_INTERVAL_MINUTES,
  DEFAULT_STORAGE_LIMIT_MIB,
  type DiscordConfig,
  type FetchConfig,
  MIN_FETCH_INTERVAL_MINUTES,
  type OAuthServerConfig,
  parseEmailList,
  parseFetchIntervalMinutes,
  parseOrigin,
  parseStorageLimitMiB,
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
export function readRetentionConfig(env: {
  STORAGE_LIMIT_MIB?: string;
  ARTICLE_RETENTION_DAYS?: string;
}): RetentionConfig {
  if (env.ARTICLE_RETENTION_DAYS?.trim()) {
    console.warn("ARTICLE_RETENTION_DAYS is no longer used; set STORAGE_LIMIT_MIB instead");
  }
  const mib = parseStorageLimitMiB(env.STORAGE_LIMIT_MIB) ?? DEFAULT_STORAGE_LIMIT_MIB;
  return { maxBytes: mib * 1024 * 1024 };
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

export interface TranslationConfig {
  apiKey: string;
  /** その場の翻訳とバッチの固定のモデル（TRANSLATION_MODEL）。なければ Models API の一覧から選ぶ */
  model?: string;
  /** 訳し直しの固定のモデル（RETRANSLATION_MODEL）。なければ Models API の一覧から選ぶ */
  retranslationModel?: string;
}

/**
 * 記事の翻訳の設定を読む（docs/decisions/translation.md の 9、15）。API キーがなければ翻訳は動かない。
 * TRANSLATION_MODEL ／ RETRANSLATION_MODEL があれば、そのモデルに固定する
 */
export function readTranslationConfig(
  env: Partial<Record<"ANTHROPIC_API_KEY" | "TRANSLATION_MODEL" | "RETRANSLATION_MODEL", string>>,
): TranslationConfig | undefined {
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return undefined;
  const model = env.TRANSLATION_MODEL?.trim();
  const retranslationModel = env.RETRANSLATION_MODEL?.trim();
  return { apiKey, ...(model && { model }), ...(retranslationModel && { retranslationModel }) };
}

export type DiscordEnvName =
  | "DISCORD_CLIENT_ID"
  | "DISCORD_CLIENT_SECRET"
  | "DISCORD_BOT_TOKEN"
  | "READER_URL";

export function readDiscordConfig(
  env: Partial<Record<DiscordEnvName, string>>,
): DiscordConfig | undefined {
  const clientId = env.DISCORD_CLIENT_ID?.trim();
  const clientSecret = env.DISCORD_CLIENT_SECRET?.trim();
  const botToken = env.DISCORD_BOT_TOKEN?.trim();
  if (!clientId || !/^[1-9][0-9]{0,19}$/.test(clientId) || !clientSecret || !botToken) {
    return undefined;
  }
  try {
    const origin = parseOrigin(env.READER_URL);
    return origin
      ? { clientId, clientSecret, botToken, redirectUri: origin + DISCORD_CALLBACK_PATH }
      : undefined;
  } catch {
    console.error("Discord is disabled: READER_URL must be an https origin");
    return undefined;
  }
}
