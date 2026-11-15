/**
 * 実行環境の緩衝層。
 *
 * アプリ（api/、jobs/ など）は、実行環境の機能をここのインターフェース越しに使う。
 * Cloudflare での実装は platform/cloudflare/ にある。移植するときは、
 * 同じインターフェースの実装を platform/<移植先>/ に足す。
 */
import type { Database } from "../db";
import type { Job } from "../jobs/job";

/** 重い処理を、API の応答と切り離して後で実行する */
export interface JobQueue {
  enqueue(jobs: readonly Job[]): Promise<void>;
}

/** 提供元に登録した、OAuth のクライアント */
export interface OAuthClient {
  clientId: string;
  clientSecret: string;
}

/**
 * Sendo が OAuth の認可サーバーになるための設定（docs/decisions/mcp.md の 3、4）。
 * Claude.ai や ChatGPT などが、OAuth で /mcp につなぐのに使う
 */
export interface OAuthServerConfig {
  /**
   * 発行者（issuer）。Sendo を外から呼ぶときのオリジン（https://sendo.example.com）。
   * 許可の画面の API は sendo-reader から中継されて届き、リクエストの URL からは Sendo の
   * オリジンが分からないので、設定で受け取る
   */
  issuer: string;
  /** 許可の画面（/oauth/authorize）を置く sendo-reader のオリジン */
  readerOrigin: string;
}

/** ブラウザのログインの設定（docs/decisions/accounts.md） */
export interface AuthConfig {
  /** ユーザーになれるメールアドレス（小文字） */
  allowedEmails: ReadonlySet<string>;
  /** Google のクライアント。なければ Google ではログインできない */
  google: OAuthClient | undefined;
  /** OAuth の認可サーバー。なければ OAuth は使えない（/mcp は MCP 用のトークンだけで使う） */
  oauth: OAuthServerConfig | undefined;
}

/** アプリが実行環境から受け取るもの */
export interface Platform {
  db: Database;
  jobs: JobQueue;
  /** 外部の URL を取得する。SSRF の確認は呼ぶ側（fetcher/）で行う */
  fetch: typeof fetch;
  now: () => Date;
  auth: AuthConfig;
}

/**
 * 許可するメールの並び（カンマか空白で区切る）を読む。小文字にそろえ、空のものは除く。
 * 設定は実行環境ごとに渡し方が違うので、読むのは緩衝層の実装で行い、形だけここで決める。
 */
export function parseEmailList(value: string | undefined): ReadonlySet<string> {
  return new Set(
    (value ?? "")
      .split(/[\s,]+/)
      .map((email) => email.trim().toLowerCase())
      .filter((email) => email !== ""),
  );
}

/** 手元で動かすときに、http でもよいホスト */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * 設定に書いたオリジン（https://sendo.example.com）を読む。末尾の / は除く。
 * https（手元で動かすなら http://localhost なども）で、パス・クエリ・フラグメント・
 * ユーザー名のないものだけを受ける。空なら undefined、形が正しくなければ例外
 */
export function parseOrigin(value: string | undefined): string | undefined {
  const text = value?.trim() ?? "";
  if (text === "") return undefined;
  const url = new URL(text);
  const secure =
    url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname));
  if (
    !secure ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    text.endsWith("?") ||
    text.endsWith("#")
  ) {
    throw new Error(`not an https origin: ${text}`);
  }
  return url.origin;
}
