/**
 * 緩衝層の実装（docs/decisions/container.md）。このディレクトリでは node:* を使ってよい
 * （docs/decisions/tech-stack.md の「守る規約」）。
 */
import path from "node:path";
import type { Database } from "../../db";
import { createClaudeTranslator } from "../../translation/claude";
import type {
  ArticleAnalyzer,
  HeavyRead,
  LanguageDetector,
  PageContentExtractor,
  Platform,
  SyncUpdates,
} from "..";
import {
  readAuthConfig,
  readDiscordConfig,
  readFetchConfig,
  readPushConfig,
  readRetentionConfig,
  readTranslationConfig,
} from "../config";
import { createSqliteArticleSearch } from "../sqlite/article-search";
import { createDiscordBotFetch } from "./discord-rest";
import { createFileObjectStore } from "./file-store";
import type { SqliteJobQueue } from "./job-queue";
import { createSafeFetch } from "./safe-fetch";

/** 環境変数で受ける設定（決定の 11） */
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

/** Platform を組み立てる */
export function createNodePlatform(input: {
  env: NodeEnv;
  db: Database;
  /** 重い読み取り（別のスレッドの接続） */
  heavyRead: HeavyRead;
  jobs: SqliteJobQueue;
  /** テストで差し替える */
  fetch?: typeof fetch;
  /** 記事のページから本文を抜く（Rust のモジュール） */
  pageContent: PageContentExtractor;
  /** 記事の主言語を調べる（Rust のモジュール） */
  languageDetection: LanguageDetector;
  /** 記事から候補の語と埋め込みを作る（Rust のモジュール） */
  articleAnalysis: ArticleAnalyzer;
  syncUpdates: SyncUpdates;
}): Platform {
  const settings = definedSettings(input.env);
  const discord = readDiscordConfig(settings);
  const fetch = input.fetch ?? createSafeFetch();
  const translation = readTranslationConfig(settings);
  const push = readPushConfig(settings);
  const now = () => new Date();
  return {
    ...(discord && {
      discord: { ...discord, botFetch: createDiscordBotFetch(fetch, discord.botToken) },
    }),
    ...(push && { push }),
    ...(translation && { translator: createClaudeTranslator({ ...translation, fetch, now }) }),
    pageContent: input.pageContent,
    languageDetection: input.languageDetection,
    articleAnalysis: input.articleAnalysis,
    syncUpdates: input.syncUpdates,
    db: input.db,
    heavyRead: input.heavyRead,
    articleSearch: createSqliteArticleSearch(input.db),
    jobs: input.jobs,
    content: createFileObjectStore(path.join(dataDirectory(input.env), "content")),
    fetch,
    now,
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
export function withPublicOrigin<Args extends unknown[]>(
  handler: (request: Request, ...args: Args) => Response | Promise<Response>,
  publicOrigin: string | undefined,
): (request: Request, ...args: Args) => Response | Promise<Response> {
  if (publicOrigin === undefined) return handler;
  return (request, ...args) => {
    const url = new URL(request.url);
    // パスを URL として解釈させない（//evil.example.com/... のようなパスで、ホストを変えられないように）。
    // 設定のオリジンに、パスとクエリだけを入れる
    const rewritten = new URL(publicOrigin);
    rewritten.pathname = url.pathname;
    rewritten.search = url.search;
    if (rewritten.href === url.href) return handler(request, ...args);
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
      ...args,
    );
  };
}
