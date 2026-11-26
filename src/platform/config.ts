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
  type PushConfig,
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

/** 翻訳の思考量（docs/decisions/translation.md の 9） */
export const TRANSLATION_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type TranslationEffort = (typeof TRANSLATION_EFFORTS)[number];

/** 系列の名前（その系列の最新を選ぶ。同じく 9） */
export const TRANSLATION_MODEL_FAMILIES = ["sonnet", "haiku", "opus"] as const;
export type TranslationModelFamily = (typeof TRANSLATION_MODEL_FAMILIES)[number];

/** 段階のモデル。系列の名前ならその系列の最新、ID ならそのモデルに固定する */
export type TranslationModelChoice = { family: TranslationModelFamily } | { id: string };

/** 1 つの段階のモデルと思考量 */
export interface TranslationTierConfig {
  model: TranslationModelChoice;
  effort: TranslationEffort;
}

export interface TranslationConfig {
  apiKey: string;
  /** 通常の段階（その場の翻訳と、閾値より短い自動の翻訳） */
  normal: TranslationTierConfig;
  /** 長文の段階（送る本文が閾値以上の自動の翻訳） */
  long: TranslationTierConfig;
  /** 品質優先の段階（訳し直し） */
  quality: TranslationTierConfig;
  /** 長文とみなす、送る本文の文字数（これ以上が長文） */
  longThresholdChars: number;
}

/** 段階の既定（docs/decisions/translation.md の 9） */
export const DEFAULT_TRANSLATION_TIERS: Readonly<
  Record<"normal" | "long" | "quality", TranslationTierConfig>
> = {
  normal: { model: { family: "sonnet" }, effort: "medium" },
  long: { model: { family: "haiku" }, effort: "low" },
  quality: { model: { family: "opus" }, effort: "medium" },
};

/** 長文の閾値の既定と範囲（同じく 9） */
export const DEFAULT_LONG_THRESHOLD_CHARS = 3_000;
export const MAX_LONG_THRESHOLD_CHARS = 60_000;

export type TranslationEnvName =
  | "ANTHROPIC_API_KEY"
  | "TRANSLATION_MODEL"
  | "TRANSLATION_EFFORT"
  | "TRANSLATION_LONG_MODEL"
  | "TRANSLATION_LONG_EFFORT"
  | "TRANSLATION_LONG_THRESHOLD_CHARS"
  | "RETRANSLATION_MODEL"
  | "RETRANSLATION_EFFORT";

/**
 * 記事の翻訳の設定を読む（docs/decisions/translation.md の 9、15）。API キーがなければ翻訳は動かない。
 * 段階ごとのモデル（系列の名前かモデルの ID）、思考量、長文の閾値を読む。知らない系列の名前、知らない
 * 思考量、範囲の外の閾値は、エラーをログに出して、その項目だけ既定で動く（空の値は書いていないものとする）
 */
export function readTranslationConfig(
  env: Partial<Record<TranslationEnvName, string>>,
): TranslationConfig | undefined {
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return undefined;
  const tier = (
    name: "normal" | "long" | "quality",
    modelEnv: TranslationEnvName,
    effortEnv: TranslationEnvName,
  ): TranslationTierConfig => {
    const fallback = DEFAULT_TRANSLATION_TIERS[name];
    return {
      model: readModelChoice(modelEnv, env[modelEnv]) ?? fallback.model,
      effort: readEffort(effortEnv, env[effortEnv]) ?? fallback.effort,
    };
  };
  return {
    apiKey,
    normal: tier("normal", "TRANSLATION_MODEL", "TRANSLATION_EFFORT"),
    long: tier("long", "TRANSLATION_LONG_MODEL", "TRANSLATION_LONG_EFFORT"),
    quality: tier("quality", "RETRANSLATION_MODEL", "RETRANSLATION_EFFORT"),
    longThresholdChars:
      readThreshold(env.TRANSLATION_LONG_THRESHOLD_CHARS) ?? DEFAULT_LONG_THRESHOLD_CHARS,
  };
}

/** `claude-` で始まればモデルの ID、それ以外は系列の名前（大文字と小文字は区別しない） */
function readModelChoice(
  name: TranslationEnvName,
  raw: string | undefined,
): TranslationModelChoice | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  if (value.startsWith("claude-")) return { id: value };
  const family = TRANSLATION_MODEL_FAMILIES.find((f) => f === value.toLowerCase());
  if (family !== undefined) return { family };
  console.error(
    `${name} is not a model family (sonnet, haiku, opus) or a model ID; using the default`,
  );
  return undefined;
}

function readEffort(name: TranslationEnvName, raw: string | undefined) {
  const value = raw?.trim();
  if (!value) return undefined;
  const effort = TRANSLATION_EFFORTS.find((e) => e === value.toLowerCase());
  if (effort !== undefined) return effort;
  console.error(`${name} must be one of ${TRANSLATION_EFFORTS.join(", ")}; using the default`);
  return undefined;
}

function readThreshold(raw: string | undefined): number | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  const chars = /^[0-9]+$/.test(value) ? Number(value) : Number.NaN;
  if (chars >= 1 && chars <= MAX_LONG_THRESHOLD_CHARS) return chars;
  console.error(
    `TRANSLATION_LONG_THRESHOLD_CHARS must be an integer from 1 to ${MAX_LONG_THRESHOLD_CHARS}; using the default`,
  );
  return undefined;
}

export type PushEnvName = "VAPID_SUBJECT" | "READER_URL";

/**
 * Web Push の設定を読む（docs/decisions/notifications.md の 18、19）。VAPID_SUBJECT と READER_URL が
 * そろっているときだけ使える。形が正しくなければ、エラーをログに出して使わない。VAPID_SUBJECT だけが
 * あるときは、Web Push を使うつもりで入れたとみて、READER_URL がないことを警告に出す
 */
export function readPushConfig(env: Partial<Record<PushEnvName, string>>): PushConfig | undefined {
  const text = env.VAPID_SUBJECT?.trim();
  if (!text) return undefined;
  const subject = parseVapidSubject(text);
  if (subject === undefined) {
    console.error("Web Push is disabled: VAPID_SUBJECT must be a mailto: address or an https: URL");
    return undefined;
  }
  let readerOrigin: string | undefined;
  try {
    readerOrigin = parseOrigin(env.READER_URL);
  } catch (error) {
    console.error("Web Push is disabled: READER_URL must be an https origin", error);
    return undefined;
  }
  if (readerOrigin === undefined) {
    console.warn("Web Push is disabled: READER_URL is not set");
    return undefined;
  }
  return { subject, readerOrigin };
}

/**
 * 宛先 1 つの mailto:（local@domain）か、https: の URL だけを受ける。プッシュサービスが送り手に連絡する先。
 * 空白と制御文字は、URL のパーサーが残したり黙って除いたりして通るので、読む前に断る
 */
function parseVapidSubject(text: string): string | undefined {
  if (/[\s\p{Cc}]/u.test(text)) return undefined;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  if (url.protocol === "mailto:") {
    const address = /^[^@]+@[^@]+$/.test(url.pathname) && url.search === "" && url.hash === "";
    return address ? url.href : undefined;
  }
  return url.protocol === "https:" ? url.href : undefined;
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
