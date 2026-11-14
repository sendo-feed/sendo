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

/** ブラウザのログインの設定（docs/decisions/accounts.md） */
export interface AuthConfig {
  /** ユーザーになれるメールアドレス（小文字） */
  allowedEmails: ReadonlySet<string>;
  /** Google のクライアント。なければ Google ではログインできない */
  google: OAuthClient | undefined;
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
