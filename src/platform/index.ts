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

/** アプリが実行環境から受け取るもの */
export interface Platform {
  db: Database;
  jobs: JobQueue;
  /** 外部の URL を取得する。SSRF の確認は呼ぶ側（fetcher/）で行う */
  fetch: typeof fetch;
  now: () => Date;
  /** REST API の認証に使うトークン。設定されていなければ、API はすべて拒む */
  apiToken: string | undefined;
}
