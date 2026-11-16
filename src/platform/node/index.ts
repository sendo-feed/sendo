/**
 * コンテナ版の緩衝層（docs/decisions/container.md）。ここと main.ts では node:* を使ってよい
 * （docs/decisions/tech-stack.md の「守る規約」）。
 */
import path from "node:path";
import type { Database } from "../../db";
import type { Platform } from "..";
import { readAuthConfig, readFetchConfig, readRetentionConfig } from "../config";
import { createFileObjectStore } from "./file-store";
import type { SqliteJobQueue } from "./job-queue";
import { createSafeFetch } from "./safe-fetch";

/** コンテナ版が読む設定。名前は Cloudflare 版と同じにする（決定の 11） */
export type NodeEnv = Readonly<Record<string, string | undefined>>;

/** 値の入っている設定だけを残す（空の値は、入っていないものとして扱う） */
function definedSettings(env: NodeEnv): Record<string, string> {
  const settings: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && value.trim() !== "") settings[name] = value;
  }
  return settings;
}

/** データ（SQLite のファイルと記事の本文）を置くディレクトリ。既定は /data（決定の 7） */
export function dataDirectory(env: NodeEnv): string {
  return env.DATA_DIR?.trim() || "/data";
}

/** コンテナ版の Platform を組み立てる */
export function createNodePlatform(input: {
  env: NodeEnv;
  db: Database;
  jobs: SqliteJobQueue;
  /** テストで差し替える */
  fetch?: typeof fetch;
}): Platform {
  const settings = definedSettings(input.env);
  return {
    db: input.db,
    jobs: input.jobs,
    content: createFileObjectStore(path.join(dataDirectory(input.env), "content")),
    fetch: input.fetch ?? createSafeFetch(),
    now: () => new Date(),
    auth: readAuthConfig(settings),
    fetchConfig: readFetchConfig(settings),
    retentionConfig: readRetentionConfig(settings),
  };
}

/**
 * リクエストの URL のオリジンを、PUBLIC_URL のオリジンに置き換える。
 *
 * コンテナは HTTP だけを受け、TLS は手前のリバースプロキシで終える（決定の 9）。そのままでは、
 * アプリから見える URL が http://<コンテナの中の名前> になり、ログインの戻り先や、同じオリジンかの
 * 確かめが合わなくなる。X-Forwarded-* のヘッダーは誰でも付けられるので信じず、設定のオリジンを使う
 */
export function withPublicOrigin(
  handler: (request: Request) => Response | Promise<Response>,
  publicOrigin: string | undefined,
): (request: Request) => Response | Promise<Response> {
  if (publicOrigin === undefined) return handler;
  return (request) => {
    const url = new URL(request.url);
    // パスを URL として解釈させない（//evil.example.com/... のようなパスで、ホストを変えられないように）。
    // 設定のオリジンに、パスとクエリだけを入れる
    const rewritten = new URL(publicOrigin);
    rewritten.pathname = url.pathname;
    rewritten.search = url.search;
    if (rewritten.href === url.href) return handler(request);
    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    return handler(
      new Request(rewritten, {
        method: request.method,
        headers: request.headers,
        body: hasBody ? request.body : null,
        signal: request.signal,
        redirect: request.redirect,
        // 本文をストリームのまま渡すのに要る（Node の fetch の決まり）
        ...(hasBody ? { duplex: "half" } : {}),
      } as RequestInit),
    );
  };
}
