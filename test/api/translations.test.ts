import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordExtractedPageContent } from "../../src/db/page-contents";
import { articles, articleTranslations, feeds, userArticles } from "../../src/db/schema";
import { configureStorage, readStorageUsage } from "../../src/db/storage";
import {
  BATCH_MARK_TTL_MS,
  decideTranslations,
  markForBatch,
  NO_BODY_HASH,
} from "../../src/db/translations";
import { runJob } from "../../src/jobs";
import { runFetchFeed } from "../../src/jobs/fetch-feed";
import type { Job } from "../../src/jobs/job";
import { runScheduled } from "../../src/jobs/schedule";
import type { LanguageDetectionResult, Platform } from "../../src/platform";
import { readTranslationConfig, type TranslationEnvName } from "../../src/platform/config";
import { createClaudeTranslator, DEFAULT_FAMILY_MODELS } from "../../src/translation/claude";
import { splitBody } from "../../src/translation/segments";
import { testDb } from "../db";
import { ARTICLE_BODY } from "../fixtures/translation-article";
import {
  createTestPlatform,
  createUser,
  fakeFetch,
  recordingSyncUpdates,
  requestApp,
  statementHook,
  subscribeFeed,
  TEST_USER,
} from "../helpers";

/**
 * 実在の英語のフィード（martinfowler.com）の項目の形と、日本語の項目、短くて判定できない項目。
 * 記事のページは 404 を返し、抜けなかったものとして記録される
 */
const FEED_HOST = "translation.example";
/**
 * 記事のページは、設定ごと・記事ごとに別のホストにする。同じホストへは 1 秒空けて取りにいく
 * （docs/decisions/content.md の 17）ので、同じホストだとテストが遅くなる
 */
let setups = 0;
const rss = (n: number, body?: string, extraEnglish = 0) => `<?xml version="1.0"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel>
  <title>Martin Fowler</title><link>https://${FEED_HOST}/</link>
  <item><title>Refactoring with Codemods to Automate API Changes</title>
    <link>https://en-${n}.${FEED_HOST}/articles/codemods-api-refactoring.html</link><guid>en</guid>
    <description>Codemods are automated scripts that transform code to apply API changes across a large codebase, removing the manual and error-prone work of updating every call site.</description>${
      body === undefined ? "" : `<content:encoded><![CDATA[${body}]]></content:encoded>`
    }</item>
  <item><title>社内の勉強会で、リファクタリングの進め方を話した</title>
    <link>https://ja-${n}.${FEED_HOST}/ja</link><guid>ja</guid>
    <description>テストを先に書いてから、小さな変更を重ねる進め方を紹介した。</description></item>
  <item><title>OK</title><link>https://und-${n}.${FEED_HOST}/short</link><guid>und</guid></item>${Array.from(
    { length: extraEnglish },
    (_, i) => `
  <item><title>Codemods, part ${i + 1}</title><link>https://en-${n}-${i}.${FEED_HOST}/part</link>
    <guid>en-${i}</guid><description>More notes on Codemods and API changes.</description></item>`,
  ).join("")}
</channel></rss>`;

/** タイトルと要約の文字で、記事の主言語を決める偽の判定 */
const languageDetection = {
  detector: "test",
  pipelineRevision: 1,
  async detect(html: string): Promise<LanguageDetectionResult> {
    const base = { score: 1, margin: 1, inputHash: "a".repeat(64) };
    if (/Codemods|GnuPG/.test(html)) return { ...base, language: "en", status: "detected" };
    if (/[ぁ-ん]/.test(html)) return { ...base, language: "ja", status: "detected" };
    return { ...base, language: "und", status: "insufficient" };
  },
};

type Reply = {
  text?: string;
  stop?: string;
  status?: number;
  errorType?: string;
  /** 出力の途中で拒否され、代わりのモデルに替わる。断ったモデルが出した途中の出力 */
  declinedText?: string;
  /** 流れを閉じない（打ち切りを確かめる） */
  hang?: boolean;
  /** 拒否の応答の stop_details（docs/decisions/translation.md の 17） */
  stopDetails?: { type: "refusal"; category: string | null; explanation: string | null };
  /** 送った断片から訳を作る（undefined を返した断片は、返さない） */
  transform?: (segment: { id: string; text: string }) => string | undefined;
};

const sse = (events: [string, unknown][]) =>
  events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");

const textBlock = (index: number, text: string): [string, unknown][] => [
  [
    "content_block_start",
    { type: "content_block_start", index, content_block: { type: "text", text: "" } },
  ],
  [
    "content_block_delta",
    { type: "content_block_delta", index, delta: { type: "text_delta", text } },
  ],
  ["content_block_stop", { type: "content_block_stop", index }],
];

/** Messages API のストリーミング（SSE）の応答を組み立てる */
function claudeResponse(
  reply: Reply,
  signal?: AbortSignal | null,
  model = "claude-sonnet-5-5",
): Response {
  if (reply.status !== undefined) {
    return Response.json(
      { type: "error", error: { type: reply.errorType ?? "api_error", message: "failed" } },
      { status: reply.status },
    );
  }
  const start: [string, unknown] = [
    "message_start",
    {
      type: "message_start",
      message: {
        id: "msg_test",
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    },
  ];
  if (reply.hang) {
    // 最初の出来事だけを送って、閉じない。呼んだ側が打ち切ったら、流れも止める
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(sse([start])));
        signal?.addEventListener("abort", () => controller.error(signal.reason));
      },
    });
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  }
  const blocks: [string, unknown][] =
    reply.declinedText === undefined
      ? textBlock(0, reply.text ?? "")
      : [
          ...textBlock(0, reply.declinedText),
          [
            "content_block_start",
            {
              type: "content_block_start",
              index: 1,
              content_block: {
                type: "fallback",
                from: { model },
                to: { model: "claude-opus-5" },
                trigger: { type: "refusal", category: null },
              },
            },
          ],
          ["content_block_stop", { type: "content_block_stop", index: 1 }],
          ...textBlock(2, reply.text ?? ""),
        ];
  const events: [string, unknown][] = [
    start,
    ...blocks,
    [
      "message_delta",
      {
        type: "message_delta",
        delta: {
          stop_reason: reply.stop ?? "end_turn",
          stop_sequence: null,
          ...(reply.stopDetails !== undefined && { stop_details: reply.stopDetails }),
        },
        usage: { output_tokens: 10 },
      },
    ],
    ["message_stop", { type: "message_stop" }],
  ];
  return new Response(sse(events), { headers: { "content-type": "text/event-stream" } });
}

const translated = (segments: { id: string; text: string }[]) => JSON.stringify({ segments });

const JA_TITLE = "コードモッドでリファクタリングし、API の変更を自動化する";
const JA_SUMMARY = "コードモッドは、大きなコードベース全体に API の変更を当てるスクリプト。";

const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

/** Models API の一覧の 1 件（実際の応答の形）。efforts は受け付ける思考量（既定はすべて） */
const modelInfo = (id: string, createdAt: string, efforts: readonly string[] = EFFORT_LEVELS) => ({
  type: "model",
  id,
  display_name: id,
  created_at: createdAt,
  capabilities: {
    effort: {
      supported: efforts.length > 0,
      ...Object.fromEntries(
        EFFORT_LEVELS.map((level) => [level, { supported: efforts.includes(level) }]),
      ),
    },
  },
});

/** Models API の応答（実際の形。1 ページで返す） */
function modelsResponse(models: ({ id: string } & Record<string, unknown>)[]): Response {
  return Response.json({
    data: models,
    has_more: false,
    first_id: models[0]?.id ?? null,
    last_id: models.at(-1)?.id ?? null,
  });
}

/** 既定の一覧。その場の翻訳には claude-sonnet-5-5 を選ぶ */
const DEFAULT_MODELS = [
  modelInfo("claude-opus-5-5", "2026-07-01T00:00:00Z"),
  modelInfo("claude-haiku-5-5", "2026-06-15T00:00:00Z"),
  modelInfo("claude-sonnet-5-5", "2026-06-01T00:00:00Z"),
  modelInfo("claude-sonnet-5", "2026-01-01T00:00:00Z"),
];

/** 偽の Message Batches API が受けたバッチ */
interface FakeBatch {
  id: string;
  requests: { custom_id: string; params: Record<string, unknown> }[];
  /** 終わった（結果を読める） */
  ended: boolean;
  /** もう見られない（404） */
  gone?: boolean;
  /** 記事ごとの結果（決めていない記事は、訳した応答） */
  results?: Map<string, unknown>;
}

/** Messages API の応答（ストリーミングでない形。バッチの結果に入る） */
const messageJson = (
  model: string,
  text: string,
  stop = "end_turn",
  stopDetails: Reply["stopDetails"] | null = null,
) => ({
  id: "msg_batch",
  type: "message",
  role: "assistant",
  model,
  content: [{ type: "text", text }],
  stop_reason: stop,
  stop_sequence: null,
  stop_details: stopDetails,
  usage: { input_tokens: 10, output_tokens: 10 },
});

/** Message Batches API のバッチの形 */
const batchJson = (batch: FakeBatch) => ({
  id: batch.id,
  type: "message_batch",
  processing_status: batch.ended ? "ended" : "in_progress",
  request_counts: { processing: 0, succeeded: 0, errored: 0, canceled: 0, expired: 0 },
  created_at: "2026-11-22T00:00:00Z",
  expires_at: "2026-11-23T00:00:00Z",
  ended_at: batch.ended ? "2026-11-22T01:00:00Z" : null,
  cancel_initiated_at: null,
  archived_at: null,
  results_url: batch.ended
    ? `https://api.anthropic.com/v1/messages/batches/${batch.id}/results`
    : null,
});

type Transform = NonNullable<Reply["transform"]>;

/** 既定の訳し方（タイトルと要約だけを訳す） */
const defaultTransform: Transform = (segment) =>
  segment.id === "title" ? JA_TITLE : segment.id === "summary" ? JA_SUMMARY : undefined;

/** 送った断片から、訳した応答の文（JSON）を作る */
function translateRequest(content: string, transform: Transform): string {
  const input = JSON.parse(content) as { segments: { id: string; text: string }[] };
  return translated(
    input.segments.flatMap((segment) => {
      const text = transform(segment);
      return text === undefined ? [] : [{ id: segment.id, text }];
    }),
  );
}

interface Setup {
  platform: Platform;
  /** 偽の Message Batches API */
  batches: {
    list: FakeBatch[];
    /** バッチを作る求めに返す失敗（なければ作る） */
    createFailure: (() => Response) | null;
    /** 見にいったバッチの ID */
    checks: string[];
    /** 見にいく求めに返す失敗（なければ答える） */
    checkFailure: (() => Response) | null;
    /** バッチの訳し方 */
    transform: Transform;
  };
  /** Models API の答え。替えると、次に一覧を取るときから効く */
  models: { reply: () => Response; requests: number; urls: URL[] };
  /** 翻訳の側の時計（一覧を取り直す時期を進める） */
  clock: { ms: number };
  enqueued: Job[];
  /** Claude API に送った要求の本文とヘッダー */
  claude: { body: string; headers: Headers }[];
  replies: Reply[];
  feedId: string;
  /** options.feeds のフィードの ID（パス → ID） */
  feedIds: Record<string, string>;
  /** WebSocket で知らせた利用者 */
  notified: string[];
}

async function setup(
  options: {
    translator?: boolean;
    callTimeoutMs?: number;
    subscribers?: string[];
    /** 英語の項目の本文（content:encoded） */
    body?: string;
    /** 翻訳の設定の環境変数（ANTHROPIC_API_KEY のほか） */
    env?: Partial<Record<TranslationEnvName, string>>;
    /** Models API の最初の答え */
    models?: () => Response;
    /** 英語の項目をこれだけ足す（guid は en-0、en-1…） */
    extraEnglish?: number;
    /** ほかのフィード（パス → RSS）。購読だけして、取得は deliver で行う */
    feeds?: Record<string, () => string>;
  } = {},
): Promise<Setup> {
  const n = ++setups;
  const replies: Reply[] = [];
  const claude: Setup["claude"] = [];
  const models: Setup["models"] = {
    reply: options.models ?? (() => modelsResponse(DEFAULT_MODELS)),
    requests: 0,
    urls: [],
  };
  const clock = { ms: Date.now() };
  const batches: Setup["batches"] = {
    list: [],
    createFailure: null,
    checks: [],
    checkFailure: null,
    transform: defaultTransform,
  };
  const fake = fakeFetch(async (url, init) => {
    const batchPath = /^\/v1\/messages\/batches(?:\/([^/]+))?(\/results)?$/.exec(url.pathname);
    if (url.hostname === "api.anthropic.com" && batchPath !== null) {
      const [, id, results] = batchPath;
      if (id === undefined) {
        if (batches.createFailure !== null) return batches.createFailure();
        const body = JSON.parse(String(init?.body ?? "{}")) as { requests: FakeBatch["requests"] };
        const batch: FakeBatch = {
          id: `msgbatch_${batches.list.length + 1}_${n}`,
          requests: body.requests,
          ended: false,
        };
        batches.list.push(batch);
        return Response.json(batchJson(batch));
      }
      const batch = batches.list.find((b) => b.id === id);
      if (results === undefined) batches.checks.push(id);
      if (results === undefined && batches.checkFailure !== null) return batches.checkFailure();
      if (batch === undefined || batch.gone) {
        return Response.json(
          { type: "error", error: { type: "not_found_error", message: "no batch" } },
          { status: 404 },
        );
      }
      if (results === undefined) return Response.json(batchJson(batch));
      const lines = batch.requests.map((request) => {
        const result = batch.results?.get(request.custom_id) ?? {
          type: "succeeded",
          message: messageJson(
            String(request.params.model),
            translateRequest(
              (request.params.messages as { content: string }[])[0]?.content ?? "{}",
              batches.transform,
            ),
          ),
        };
        return JSON.stringify({ custom_id: request.custom_id, result });
      });
      return new Response(`${lines.join("\n")}\n`, {
        headers: { "content-type": "application/binary" },
      });
    }
    if (url.hostname === "api.anthropic.com" && url.pathname === "/v1/models") {
      models.requests += 1;
      models.urls.push(url);
      return models.reply();
    }
    if (url.hostname === "api.anthropic.com") {
      const sent = String(init?.body ?? "");
      claude.push({ body: sent, headers: new Headers(init?.headers) });
      // 応答のモデルは、送ったモデル
      const model = (JSON.parse(sent) as { model?: string }).model;
      const reply = replies.shift() ?? {
        transform: (segment) =>
          segment.id === "title" ? JA_TITLE : segment.id === "summary" ? JA_SUMMARY : undefined,
      };
      const { transform } = reply;
      if (transform !== undefined) {
        const request = JSON.parse(sent) as { messages: { content: string }[] };
        const input = JSON.parse(request.messages[0]?.content ?? "{}") as {
          segments: { id: string; text: string }[];
        };
        const out = input.segments.flatMap((segment) => {
          const text = transform(segment);
          return text === undefined ? [] : [{ id: segment.id, text }];
        });
        return claudeResponse({ text: translated(out) }, init?.signal, model);
      }
      return claudeResponse(reply, init?.signal, model);
    }
    if (url.pathname === "/feed.xml") {
      return new Response(rss(n, options.body, options.extraEnglish));
    }
    const other = options.feeds?.[url.pathname];
    if (url.hostname === FEED_HOST && other !== undefined) return new Response(other());
    return new Response("not found", { status: 404 });
  });
  const recording = recordingSyncUpdates();
  const created = createTestPlatform({
    fetch: fake.fetch,
    languageDetection,
    syncUpdates: recording.syncUpdates,
  });
  const platform: Platform = {
    ...created.platform,
    ...(options.translator !== false && {
      translator: createClaudeTranslator({
        // 本番と同じく、環境変数から設定を読む
        ...translationConfig(options.env),
        fetch: fake.fetch,
        now: () => new Date(clock.ms),
        ...(options.callTimeoutMs !== undefined && { callTimeoutMs: options.callTimeoutMs }),
      }),
    }),
  };
  const feed = await subscribeFeed(platform, { url: `https://${FEED_HOST}/feed.xml` });
  const feedIds: Record<string, string> = {};
  for (const path of Object.keys(options.feeds ?? {})) {
    feedIds[path] = (await subscribeFeed(platform, { url: `https://${FEED_HOST}${path}` })).id;
  }
  for (const userId of options.subscribers ?? []) {
    await subscribeFeed(platform, { feedId: feed.id, url: feed.url, userId });
  }
  await runFetchFeed(platform, feed.id);
  // 取得の仕事が積んだ、ページの抜き取りを動かす（ページは 404 で、抜けなかったと記録される）
  for (const job of created.enqueued.splice(0)) {
    if (job.type === "extract-page") await runJob(platform, job);
  }
  await runJob(platform, { type: "detect-article-languages" });
  // 判定は 1 回の仕事で決まった数までなので、積まれた続きも動かす
  for (let job = created.enqueued.find((j) => j.type === "detect-article-languages"); job; ) {
    created.enqueued.splice(created.enqueued.indexOf(job), 1);
    await runJob(platform, job);
    job = created.enqueued.find((j) => j.type === "detect-article-languages");
  }
  created.enqueued.length = 0;
  recording.notified.length = 0;
  return {
    platform,
    batches,
    models,
    clock,
    enqueued: created.enqueued,
    claude,
    replies,
    feedId: feed.id,
    feedIds,
    notified: recording.notified,
  };
}

async function articleId(platform: Platform, guid: string): Promise<string> {
  const row = await platform.db
    .select({ id: articles.id })
    .from(articles)
    .where(eq(articles.guid, guid))
    .get();
  if (!row) throw new Error(`no article ${guid}`);
  return row.id;
}

/** 環境変数から翻訳の設定を読む（本番の platform/node と同じ道） */
function translationConfig(env: Partial<Record<TranslationEnvName, string>> = {}) {
  const config = readTranslationConfig({ ANTHROPIC_API_KEY: "sk-test-secret", ...env });
  if (config === undefined) throw new Error("no translation config");
  return config;
}

const translationOf = (platform: Platform, id: string) =>
  platform.db.select().from(articleTranslations).where(eq(articleTranslations.articleId, id)).get();

const maintain = (platform: Platform) => runJob(platform, { type: "maintain-translations" });

/** 応答の本文（テストで見る項目だけ） */
interface Body {
  status?: string;
  title?: string | null;
  summary?: string | null;
  error?: { code: string };
}

/** その場の翻訳を求める */
async function request(s: Setup, id: string) {
  const response = await requestApp(s.platform, `/api/v1/articles/${id}/translation`, {
    method: "POST",
  });
  return { response, body: (await response.json()) as Body };
}

async function runQueuedTranslation(s: Setup) {
  const job = s.enqueued.find((j) => j.type === "translate-article");
  if (!job) throw new Error("no translate-article job");
  await runJob(s.platform, job);
  return job;
}

const OPUS_TITLE = "コードモッドで、API の変更を自動で当てる";
const OPUS_SUMMARY =
  "コードモッドは、大きなコードベースの全体に API の変更を当てるスクリプトである。";

/** Opus の訳（訳し直しの応答） */
const opusReply: Reply = {
  transform: (segment) =>
    segment.id === "title" ? OPUS_TITLE : segment.id === "summary" ? OPUS_SUMMARY : undefined,
};

/** 英語の記事を、その場の翻訳で訳しておく（Sonnet。訳し直しの前提） */
async function translatedArticle(s: Setup): Promise<string> {
  await maintain(s.platform);
  const id = await articleId(s.platform, "en");
  expect((await request(s, id)).response.status).toBe(202);
  await runQueuedTranslation(s);
  s.enqueued.length = 0;
  s.claude.length = 0;
  s.notified.length = 0;
  return id;
}

/** 訳し直しを求める（本文で指定する。docs/decisions/translation.md の 13） */
async function retranslate(s: Setup, id: string, platform: Platform = s.platform) {
  const response = await requestApp(platform, `/api/v1/articles/${id}/translation`, {
    method: "POST",
    json: { retranslate: true },
  });
  return { response, body: (await response.json()) as Body };
}

beforeEach(async () => {
  await testDb.exec("DELETE FROM feeds");
  await testDb.exec("DELETE FROM content_notes");
  await testDb.exec("DELETE FROM content_sizes");
  await testDb.exec("UPDATE storage_usage SET limit_bytes = 268435456 WHERE id = 1");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("訳すかどうかを決める（docs/decisions/translation.md の 1、2）", () => {
  it("英語は queued、日本語は skipped、判定できない記事は untranslated の行を作る", async () => {
    const s = await setup();
    await maintain(s.platform);
    expect(await translationOf(s.platform, await articleId(s.platform, "en"))).toMatchObject({
      status: "queued",
      language: "en",
    });
    expect(await translationOf(s.platform, await articleId(s.platform, "ja"))).toMatchObject({
      status: "skipped",
      language: "ja",
    });
    expect(await translationOf(s.platform, await articleId(s.platform, "und"))).toMatchObject({
      status: "untranslated",
      language: "und",
    });
  });

  it("2 回目の定期実行で、行を作り直さない", async () => {
    const s = await setup();
    await maintain(s.platform);
    const id = await articleId(s.platform, "en");
    const first = await translationOf(s.platform, id);
    await maintain(s.platform);
    expect(await translationOf(s.platform, id)).toEqual(first);
  });

  it("ページの判定を待つ間は決めず、取り込んでから 1 時間たったら決める", async () => {
    const s = await setup();
    const id = await articleId(s.platform, "en");
    // ページの抜き取りがまだ終わっていない記事にする
    await testDb.exec(`DELETE FROM page_contents WHERE article_id = '${id}'`);
    await maintain(s.platform);
    expect(await translationOf(s.platform, id)).toBeUndefined();
    await s.platform.db
      .update(articles)
      .set({ createdAt: new Date(Date.now() - 60 * 60 * 1000 - 1000) })
      .where(eq(articles.id, id))
      .run();
    await maintain(s.platform);
    expect(await translationOf(s.platform, id)).toMatchObject({ status: "queued" });
  });

  it("取り込んでから 1 日たった記事、受信箱にない記事、Discord の投稿には行を作らない", async () => {
    const s = await setup();
    const old = await articleId(s.platform, "en");
    const orphan = await articleId(s.platform, "ja");
    await s.platform.db
      .update(articles)
      .set({ createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000 - 1000) })
      .where(eq(articles.id, old))
      .run();
    await s.platform.db.delete(userArticles).where(eq(userArticles.articleId, orphan)).run();
    await maintain(s.platform);
    expect(await translationOf(s.platform, old)).toBeUndefined();
    expect(await translationOf(s.platform, orphan)).toBeUndefined();
  });

  it("Discord の投稿には行を作らない", async () => {
    const s = await setup();
    await s.platform.db
      .update(feeds)
      .set({ discordCursor: "0" })
      .where(eq(feeds.id, s.feedId))
      .run();
    await maintain(s.platform);
    expect(await translationOf(s.platform, await articleId(s.platform, "en"))).toBeUndefined();
  });

  it("API キーがなければ、行を作らない", async () => {
    const s = await setup({ translator: false });
    await maintain(s.platform);
    expect(await translationOf(s.platform, await articleId(s.platform, "en"))).toBeUndefined();
  });

  it("定期実行が、訳文の手入れを積む", async () => {
    const { platform, enqueued } = createTestPlatform();
    await runScheduled(platform, new Date("2026-11-22T00:05:00Z"));
    expect(enqueued).toContainEqual({ type: "maintain-translations" });
  });
});

describe("その場の翻訳（docs/decisions/translation.md の 5、13）", () => {
  it("queued の記事を求めると 202 で translating になり、仕事が訳して translated にする", async () => {
    const s = await setup();
    await maintain(s.platform);
    const id = await articleId(s.platform, "en");
    const { response, body } = await request(s, id);
    expect(response.status).toBe(202);
    expect(body).toEqual({ status: "translating" });
    expect(await translationOf(s.platform, id)).toMatchObject({ status: "translating" });

    await runQueuedTranslation(s);
    expect(s.claude).toHaveLength(1);
    expect(await translationOf(s.platform, id)).toMatchObject({
      status: "translated",
      title: JA_TITLE,
      summary: JA_SUMMARY,
      model: "claude-sonnet-5-5",
      startedAt: null,
    });

    const got = await requestApp(s.platform, `/api/v1/articles/${id}/translation`);
    expect(got.status).toBe(200);
    expect(await got.json()).toMatchObject({
      title: JA_TITLE,
      summary: JA_SUMMARY,
      model: "claude-sonnet-5-5",
    });
  });

  it("送るのは訳す文だけで、記事の URL、フィードの名前、ユーザーのことを送らない", async () => {
    const s = await setup();
    await maintain(s.platform);
    await request(s, await articleId(s.platform, "en"));
    await runQueuedTranslation(s);
    const [sent] = s.claude;
    expect(sent?.body).toContain("Refactoring with Codemods");
    for (const secret of [FEED_HOST, "Martin Fowler", TEST_USER.id, TEST_USER.email]) {
      expect(sent?.body).not.toContain(secret);
    }
    expect(sent?.headers.get("authorization")).toBe("Bearer sk-test-secret");
    expect(sent?.headers.get("anthropic-beta")).toContain("server-side-fallback-2026-07-01");
  });

  it("訳せない記事、訳した記事、キーのない sendo、受信箱にない記事は、送らずに断る", async () => {
    const s = await setup();
    await maintain(s.platform);
    const ja = await request(s, await articleId(s.platform, "ja"));
    expect(ja.response.status).toBe(409);
    expect(ja.body.error?.code).toBe("translation_not_supported");

    const en = await articleId(s.platform, "en");
    await request(s, en);
    await runQueuedTranslation(s);
    const again = await request(s, en);
    expect(again.body.error?.code).toBe("translation_exists");

    const missing = await request(s, "missing");
    expect(missing.response.status).toBe(404);

    const noKey = await setup({ translator: false });
    const unavailable = await request(noKey, await articleId(noKey.platform, "en"));
    expect(unavailable.response.status).toBe(503);
    expect(unavailable.body.error?.code).toBe("translation_unavailable");
    expect(s.claude).toHaveLength(1);
    expect(noKey.claude).toHaveLength(0);
  });

  it("行のない記事（まだ決めていない）は translation_not_supported", async () => {
    const s = await setup();
    const res = await request(s, await articleId(s.platform, "en"));
    expect(res.body.error?.code).toBe("translation_not_supported");
  });

  it("2 つの求めが重なっても、始めるのは 1 つで、送るのは 1 回だけ", async () => {
    const s = await setup();
    await maintain(s.platform);
    const id = await articleId(s.platform, "en");
    const results = await Promise.all([request(s, id), request(s, id)]);
    expect(results.map((r) => r.response.status).sort()).toEqual([202, 409]);
    expect(s.enqueued.filter((j) => j.type === "translate-article")).toHaveLength(1);
    await runQueuedTranslation(s);
    expect(s.claude).toHaveLength(1);
  });

  it("訳の中のタグの文字は、文字のまま返す", async () => {
    const s = await setup();
    await maintain(s.platform);
    const id = await articleId(s.platform, "en");
    s.replies.push({ text: translated([{ id: "title", text: "<script>alert(1)</script>" }]) });
    await request(s, id);
    await runQueuedTranslation(s);
    const got = (await (
      await requestApp(s.platform, `/api/v1/articles/${id}/translation`)
    ).json()) as Body;
    expect(got.title).toBe("<script>alert(1)</script>");
    // 返ってこなかった要約は、原文のまま残る
    expect(got.summary).toContain("Codemods are automated scripts");
  });
});

describe("失敗と、止まった翻訳（docs/decisions/translation.md の 7、8）", () => {
  it("429 は仕事がやり直し、3 回目で untranslated に戻す。もう一度求めれば訳せる", async () => {
    const s = await setup();
    await maintain(s.platform);
    const id = await articleId(s.platform, "en");
    s.replies.push(
      { status: 429, errorType: "rate_limit_error" },
      { status: 529, errorType: "overloaded_error" },
      { status: 500 },
    );
    await request(s, id);
    const job = s.enqueued.find((j) => j.type === "translate-article");
    if (!job) throw new Error("no job");
    await expect(runJob(s.platform, job)).rejects.toThrow();
    await expect(runJob(s.platform, job)).rejects.toThrow();
    await runJob(s.platform, job);
    expect(s.claude).toHaveLength(3);
    expect(await translationOf(s.platform, id)).toMatchObject({ status: "untranslated" });

    s.enqueued.length = 0;
    expect((await request(s, id)).response.status).toBe(202);
    await runQueuedTranslation(s);
    expect(await translationOf(s.platform, id)).toMatchObject({ status: "translated" });
  });

  it.each([
    ["拒否", { text: "", stop: "refusal" }],
    ["上限で切れた応答", { text: '{"segments":[', stop: "max_tokens" }],
    ["読めない JSON", { text: "not json" }],
    ["要求の形の誤り（400）", { status: 400, errorType: "invalid_request_error" }],
    ["モデルの名前の誤り（404）", { status: 404, errorType: "not_found_error" }],
    ["認証の失敗（401）", { status: 401, errorType: "authentication_error" }],
    ["権限の不足（403）", { status: 403, errorType: "permission_error" }],
  ])("%s は、1 回で untranslated にする", async (_name, reply) => {
    const s = await setup();
    await maintain(s.platform);
    const id = await articleId(s.platform, "en");
    s.replies.push(reply);
    await request(s, id);
    await runQueuedTranslation(s);
    expect(s.claude).toHaveLength(1);
    expect(await translationOf(s.platform, id)).toMatchObject({ status: "untranslated" });
  });

  it("1 時間を過ぎた translating を戻し、戻したあとの古い仕事は呼ばずに書かない", async () => {
    const s = await setup();
    await maintain(s.platform);
    const id = await articleId(s.platform, "en");
    await request(s, id);
    await s.platform.db
      .update(articleTranslations)
      .set({ startedAt: new Date(Date.now() - 60 * 60 * 1000 - 1000) })
      .where(eq(articleTranslations.articleId, id))
      .run();
    // 始めた時刻を書き換えたので、積まれた仕事は古い仕事になる
    await maintain(s.platform);
    expect(await translationOf(s.platform, id)).toMatchObject({ status: "untranslated" });
    await runQueuedTranslation(s);
    expect(s.claude).toHaveLength(0);
    expect(await translationOf(s.platform, id)).toMatchObject({ status: "untranslated" });
  });

  it("始めてから 1 時間たつ前は、戻さない", async () => {
    const s = await setup();
    await maintain(s.platform);
    const id = await articleId(s.platform, "en");
    await request(s, id);
    await s.platform.db
      .update(articleTranslations)
      .set({ startedAt: new Date(Date.now() - 59 * 60 * 1000) })
      .where(eq(articleTranslations.articleId, id))
      .run();
    await maintain(s.platform);
    expect(await translationOf(s.platform, id)).toMatchObject({ status: "translating" });
  });

  it("同じ仕事が 2 回動いても、2 回目は呼ばず、書いた訳文を上書きしない", async () => {
    const s = await setup();
    await maintain(s.platform);
    const id = await articleId(s.platform, "en");
    await request(s, id);
    await runQueuedTranslation(s);
    s.replies.push({ text: translated([{ id: "title", text: "別の訳" }]) });
    await runQueuedTranslation(s);
    expect(s.claude).toHaveLength(1);
    expect(await translationOf(s.platform, id)).toMatchObject({ title: JA_TITLE });
  });

  it("訳す前に記事が消えたら、呼ばない", async () => {
    const s = await setup();
    await maintain(s.platform);
    const id = await articleId(s.platform, "en");
    await request(s, id);
    await s.platform.db.delete(articles).where(eq(articles.id, id)).run();
    await runQueuedTranslation(s);
    expect(s.claude).toHaveLength(0);
  });

  it("出力の途中で拒否され、代わりのモデルが訳したら、代わりのモデルの訳を読む", async () => {
    const s = await setup();
    await maintain(s.platform);
    const id = await articleId(s.platform, "en");
    s.replies.push({
      declinedText: '{"segments":[{"id":"ti',
      text: translated([
        { id: "title", text: JA_TITLE },
        { id: "summary", text: JA_SUMMARY },
      ]),
    });
    await request(s, id);
    await runQueuedTranslation(s);
    expect(await translationOf(s.platform, id)).toMatchObject({
      status: "translated",
      title: JA_TITLE,
      model: "claude-opus-5",
    });
  });

  it("流れが打ち切りの時間までに終わらなければ打ち切り、やり直せる失敗として数える", async () => {
    const s = await setup({ callTimeoutMs: 200 });
    await maintain(s.platform);
    const id = await articleId(s.platform, "en");
    s.replies.push({ hang: true });
    await request(s, id);
    await expect(runQueuedTranslation(s)).rejects.toThrow();
    expect(await translationOf(s.platform, id)).toMatchObject({
      status: "translating",
      attempts: 1,
    });
  });

  it("仕事を積めなければ、始める前の状態に戻す", async () => {
    const s = await setup();
    await maintain(s.platform);
    const id = await articleId(s.platform, "en");
    const platform: Platform = {
      ...s.platform,
      jobs: {
        async enqueue() {
          throw new Error("queue is busy");
        },
      },
    };
    const response = await requestApp(platform, `/api/v1/articles/${id}/translation`, {
      method: "POST",
    });
    expect(response.status).toBe(500);
    expect(await translationOf(s.platform, id)).toMatchObject({
      status: "queued",
      startedAt: null,
    });
  });

  it("仕事を積めずに戻したときも、戻した状態が届き、知らされる", async () => {
    const s = await setup();
    await maintain(s.platform);
    const id = await articleId(s.platform, "en");
    const before = await requestApp(s.platform, "/api/v1/sync");
    const { cursor } = (await before.json()) as { cursor: string };
    s.notified.length = 0;
    const platform: Platform = {
      ...s.platform,
      jobs: {
        async enqueue() {
          throw new Error("queue is busy");
        },
      },
    };
    const response = await requestApp(platform, `/api/v1/articles/${id}/translation`, {
      method: "POST",
    });
    expect(response.status).toBe(500);
    expect(s.notified).toContain(TEST_USER.id);
    const after = await requestApp(s.platform, `/api/v1/sync?cursor=${encodeURIComponent(cursor)}`);
    const body = (await after.json()) as {
      articles: { id: string; translation: { status: string } | null }[];
    };
    expect(body.articles.find((a) => a.id === id)?.translation).toMatchObject({ status: "queued" });
  });

  it("知らせる相手を読めなくても、求めは受け付けて 202 を返す", async () => {
    const s = await setup();
    await maintain(s.platform);
    const id = await articleId(s.platform, "en");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const hook = statementHook(/select distinct "user_id" from "user_articles"/, async () => {
      throw new Error("database is busy");
    });
    const response = await requestApp(
      { ...s.platform, db: hook.db },
      `/api/v1/articles/${id}/translation`,
      { method: "POST" },
    );
    expect(hook.fired()).toBe(true);
    expect(response.status).toBe(202);
    expect(await translationOf(s.platform, id)).toMatchObject({ status: "translating" });
    expect(s.enqueued.some((j) => j.type === "translate-article")).toBe(true);
  });

  it("API キーがなくても、止まった translating を戻す", async () => {
    const s = await setup();
    await maintain(s.platform);
    const id = await articleId(s.platform, "en");
    await request(s, id);
    await s.platform.db
      .update(articleTranslations)
      .set({ startedAt: new Date(Date.now() - 2 * 60 * 60 * 1000) })
      .where(eq(articleTranslations.articleId, id))
      .run();
    const { translator: _removed, ...withoutKey } = s.platform;
    await maintain(withoutKey);
    expect(await translationOf(s.platform, id)).toMatchObject({ status: "untranslated" });
  });

  it("キーとエラーの中身を、ログと応答に出さない", async () => {
    const s = await setup();
    await maintain(s.platform);
    const id = await articleId(s.platform, "en");
    const logs: unknown[] = [];
    for (const level of ["log", "info", "warn", "error"] as const) {
      vi.spyOn(console, level).mockImplementation((...args) => logs.push(args));
    }
    s.replies.push({ status: 400, errorType: "invalid_request_error" });
    const { body } = await request(s, id);
    await runQueuedTranslation(s);
    const text = JSON.stringify(logs) + JSON.stringify(body);
    expect(text).not.toContain("sk-test-secret");
  });
});

describe("置き場と容量（docs/decisions/translation.md の 12）", () => {
  it("訳文の行と訳した文字の大きさを、保存容量に入れ、記事を消すと一緒に消す", async () => {
    const s = await setup();
    const before = (await readStorageUsage(s.platform.db)).bytes;
    await maintain(s.platform);
    const id = await articleId(s.platform, "en");
    const decided = (await readStorageUsage(s.platform.db)).bytes;
    expect(decided - before).toBe(512 * 3);
    await request(s, id);
    await runQueuedTranslation(s);
    const after = (await readStorageUsage(s.platform.db)).bytes;
    const bytes = (text: string) => new TextEncoder().encode(text).length;
    expect(after - decided).toBe(bytes(JA_TITLE) + bytes(JA_SUMMARY) + bytes("claude-sonnet-5-5"));

    await s.platform.db.delete(articles).where(eq(articles.id, id)).run();
    expect(await translationOf(s.platform, id)).toBeUndefined();
  });

  it("容量が足りなければ、送らずに untranslated に戻す", async () => {
    const s = await setup();
    await maintain(s.platform);
    const id = await articleId(s.platform, "en");
    expect((await request(s, id)).response.status).toBe(202);
    const usage = await readStorageUsage(s.platform.db);
    const platform = { ...s.platform, retentionConfig: { maxBytes: usage.bytes + 100 } };
    const job = s.enqueued.find((j) => j.type === "translate-article");
    if (!job) throw new Error("no job");
    await runJob(platform, job);
    expect(s.claude).toHaveLength(0);
    expect(await translationOf(s.platform, id)).toMatchObject({ status: "untranslated" });
  });

  it("受け取ったあとで容量が足りなければ、呼び直さずに untranslated に戻す", async () => {
    const s = await setup();
    await maintain(s.platform);
    const id = await articleId(s.platform, "en");
    await request(s, id);
    // 見積もり（入力の倍）には収まるが、受け取った訳文は収まらない上限にする
    const usage = await readStorageUsage(s.platform.db);
    const platform = { ...s.platform, retentionConfig: { maxBytes: usage.bytes + 2000 } };
    s.replies.push({ text: translated([{ id: "title", text: "訳".repeat(5000) }]) });
    const job = s.enqueued.find((j) => j.type === "translate-article");
    if (!job) throw new Error("no job");
    await runJob(platform, job);
    expect(s.claude).toHaveLength(1);
    expect(await translationOf(s.platform, id)).toMatchObject({
      status: "untranslated",
      title: null,
    });
  });
});

describe("差分同期で配る（docs/decisions/sync.md の 10、translation.md の 14）", () => {
  type SyncedArticle = {
    id: string;
    deleted: boolean;
    readAt?: string | null;
    translation?: {
      language: string;
      status: string;
      title: string | null;
      summary: string | null;
      translatedAt: string | null;
      retranslated: boolean;
      failure: { kind: string; category: string | null; stage: string } | null;
    } | null;
  };

  /** 差分同期を、hasMore が false になるまで続けて呼ぶ。token を省くとテストのユーザー */
  async function sync(platform: Platform, token?: string, cursor?: string) {
    const articles: SyncedArticle[] = [];
    let next = cursor;
    for (;;) {
      const query = next === undefined ? "" : `?cursor=${encodeURIComponent(next)}`;
      const response = await requestApp(platform, `/api/v1/sync${query}`, {
        ...(token !== undefined && { token }),
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        cursor: string;
        hasMore: boolean;
        articles: SyncedArticle[];
      };
      articles.push(...body.articles);
      next = body.cursor;
      if (!body.hasMore) return { cursor: body.cursor, articles };
    }
  }

  const translationIn = (body: { articles: SyncedArticle[] }, id: string) =>
    body.articles.find((a) => a.id === id)?.translation;

  it("訳すかどうかが決まると、記事を持つ 2 人に元の言語と状態が届き、知らされる。持たない人には届かない", async () => {
    const other = await createUser();
    const outsider = await createUser();
    const s = await setup({ subscribers: [other.id] });
    const en = await articleId(s.platform, "en");
    const ja = await articleId(s.platform, "ja");
    const und = await articleId(s.platform, "und");
    const a0 = await sync(s.platform);
    const b0 = await sync(s.platform, other.token);
    const c0 = await sync(s.platform, outsider.token);
    // まだ決めていない記事（行がない）には付かない
    expect(a0.articles.map((a) => a.translation)).toEqual([null, null, null]);

    await maintain(s.platform);
    const a1 = await sync(s.platform, undefined, a0.cursor);
    const b1 = await sync(s.platform, other.token, b0.cursor);
    for (const body of [a1, b1]) {
      expect(translationIn(body, en)).toEqual({
        language: "en",
        status: "queued",
        title: null,
        summary: null,
        translatedAt: null,
        retranslated: false,
        failure: null,
      });
      expect(translationIn(body, und)).toMatchObject({ language: "und", status: "untranslated" });
      // skipped は配らないので、番号も進まない
      expect(body.articles.map((a) => a.id)).not.toContain(ja);
    }
    expect(new Set(s.notified)).toEqual(new Set([TEST_USER.id, other.id]));
    expect((await sync(s.platform, outsider.token, c0.cursor)).articles).toEqual([]);

    // 最初の同期でも、日本語の記事には付かない
    const fresh = await sync(s.platform, other.token);
    expect(translationIn(fresh, ja)).toBeNull();
    expect(translationIn(fresh, en)).toMatchObject({ status: "queued" });
  });

  it("その場で訳すと、translating と、訳し終えた訳文が 2 人に届き、知らされる", async () => {
    const other = await createUser();
    const s = await setup({ subscribers: [other.id] });
    const en = await articleId(s.platform, "en");
    await maintain(s.platform);
    const a0 = await sync(s.platform);
    const b0 = await sync(s.platform, other.token);
    s.notified.length = 0;

    expect((await request(s, en)).response.status).toBe(202);
    // 求めたのはテストのユーザーだけでも、記事を持つもう 1 人にも知らせる
    expect(new Set(s.notified)).toEqual(new Set([TEST_USER.id, other.id]));
    const a1 = await sync(s.platform, undefined, a0.cursor);
    const b1 = await sync(s.platform, other.token, b0.cursor);
    for (const body of [a1, b1]) {
      expect(body.articles.map((a) => a.id)).toEqual([en]);
      expect(translationIn(body, en)).toMatchObject({ status: "translating", title: null });
    }

    s.notified.length = 0;
    await runQueuedTranslation(s);
    expect(new Set(s.notified)).toEqual(new Set([TEST_USER.id, other.id]));
    const row = await translationOf(s.platform, en);
    for (const body of [
      await sync(s.platform, undefined, a1.cursor),
      await sync(s.platform, other.token, b1.cursor),
    ]) {
      expect(body.articles.map((a) => a.id)).toEqual([en]);
      expect(translationIn(body, en)).toEqual({
        language: "en",
        status: "translated",
        title: JA_TITLE,
        summary: JA_SUMMARY,
        translatedAt: row?.translatedAt?.toISOString(),
        retranslated: false,
        failure: null,
      });
    }

    // 最初の同期では、訳し済みの記事に訳文が付く
    const fresh = await sync(s.platform, other.token);
    expect(translationIn(fresh, en)).toMatchObject({ status: "translated", title: JA_TITLE });
  });

  it("やり直しを数えただけでは番号が進まず、知らせない。やり直しを使い切って戻ると届き、知らされる", async () => {
    const s = await setup();
    const en = await articleId(s.platform, "en");
    await maintain(s.platform);
    await request(s, en);
    const a0 = await sync(s.platform);
    s.notified.length = 0;
    s.replies.push(
      { status: 429, errorType: "rate_limit_error" },
      { status: 529, errorType: "overloaded_error" },
      { status: 500 },
    );
    const job = s.enqueued.find((j) => j.type === "translate-article");
    if (!job) throw new Error("no job");

    await expect(runJob(s.platform, job)).rejects.toThrow();
    expect(s.notified).toEqual([]);
    const a1 = await sync(s.platform, undefined, a0.cursor);
    expect(a1.articles).toEqual([]);

    await expect(runJob(s.platform, job)).rejects.toThrow();
    await runJob(s.platform, job);
    expect(s.notified).toEqual([TEST_USER.id]);
    const a2 = await sync(s.platform, undefined, a1.cursor);
    expect(translationIn(a2, en)).toMatchObject({ status: "untranslated", title: null });
  });

  it("訳し直すと、記事を持つ全員に、最中はもとの訳文が、終わると新しい訳文と訳し直しの印が届き、知らされる", async () => {
    const other = await createUser();
    const s = await setup({ subscribers: [other.id] });
    const en = await translatedArticle(s);
    const before = await translationOf(s.platform, en);
    const a0 = await sync(s.platform);
    const b0 = await sync(s.platform, other.token);

    expect((await retranslate(s, en)).response.status).toBe(202);
    expect(new Set(s.notified)).toEqual(new Set([TEST_USER.id, other.id]));
    const a1 = await sync(s.platform, undefined, a0.cursor);
    const b1 = await sync(s.platform, other.token, b0.cursor);
    for (const body of [a1, b1]) {
      expect(body.articles.map((a) => a.id)).toEqual([en]);
      expect(translationIn(body, en)).toEqual({
        language: "en",
        status: "translating",
        title: JA_TITLE,
        summary: JA_SUMMARY,
        translatedAt: before?.translatedAt?.toISOString(),
        retranslated: false,
        failure: null,
      });
    }

    s.notified.length = 0;
    s.replies.push(opusReply);
    await runQueuedTranslation(s);
    expect(new Set(s.notified)).toEqual(new Set([TEST_USER.id, other.id]));
    const row = await translationOf(s.platform, en);
    for (const body of [
      await sync(s.platform, undefined, a1.cursor),
      await sync(s.platform, other.token, b1.cursor),
    ]) {
      expect(body.articles.map((a) => a.id)).toEqual([en]);
      expect(translationIn(body, en)).toEqual({
        language: "en",
        status: "translated",
        title: OPUS_TITLE,
        summary: OPUS_SUMMARY,
        translatedAt: row?.translatedAt?.toISOString(),
        retranslated: true,
        failure: null,
      });
    }
    // 最初の同期でも印が付く
    expect(translationIn(await sync(s.platform, other.token), en)).toMatchObject({
      retranslated: true,
      failure: null,
    });
  });

  it("訳し直しの印だけが変わっても、番号が進んで届く（トリガーの条件）", async () => {
    const s = await setup();
    const en = await translatedArticle(s);
    const a0 = await sync(s.platform);
    // 印は本番では訳した時刻と一緒に変わる。印だけで振るかを、直接の書き込みで確かめる
    await testDb.exec(
      `UPDATE article_translations SET retranslated = 1 WHERE article_id = '${en}'`,
    );
    const a1 = await sync(s.platform, undefined, a0.cursor);
    expect(a1.articles.map((a) => a.id)).toEqual([en]);
    expect(translationIn(a1, en)).toMatchObject({ retranslated: true });
  });

  it("止まった translating を戻すと、届き、知らされる", async () => {
    const s = await setup();
    const en = await articleId(s.platform, "en");
    await maintain(s.platform);
    await request(s, en);
    const a0 = await sync(s.platform);
    s.notified.length = 0;
    await s.platform.db
      .update(articleTranslations)
      .set({ startedAt: new Date(Date.now() - 60 * 60 * 1000 - 1000) })
      .where(eq(articleTranslations.articleId, en))
      .run();

    await maintain(s.platform);
    expect(s.notified).toEqual([TEST_USER.id]);
    const a1 = await sync(s.platform, undefined, a0.cursor);
    expect(translationIn(a1, en)).toMatchObject({ status: "untranslated" });
  });

  it("番号を振り直しても、既読・スター・既読の番号は変わらない", async () => {
    const s = await setup();
    const en = await articleId(s.platform, "en");
    await maintain(s.platform);
    const patched = await requestApp(s.platform, `/api/v1/articles/${en}`, {
      method: "PATCH",
      json: { read: true, starred: true },
    });
    expect(patched.status).toBe(200);
    const inbox = () =>
      s.platform.db.select().from(userArticles).where(eq(userArticles.articleId, en)).get();
    const before = await inbox();

    await request(s, en);
    await runQueuedTranslation(s);
    const after = await inbox();
    expect(after?.seq).toBeGreaterThan(before?.seq ?? Number.POSITIVE_INFINITY);
    expect({ readAt: after?.readAt, starredAt: after?.starredAt, readSeq: after?.readSeq }).toEqual(
      { readAt: before?.readAt, starredAt: before?.starredAt, readSeq: before?.readSeq },
    );
  });

  it("訳文を書く文の直前に既読の操作が入っても、番号が重ならず、既読も訳文も残る", async () => {
    const s = await setup();
    const en = await articleId(s.platform, "en");
    await maintain(s.platform);
    await request(s, en);
    const a0 = await sync(s.platform);
    const hook = statementHook(
      /update article_translations set status = 'translated'/,
      async () => {
        const response = await requestApp(s.platform, `/api/v1/articles/${en}`, {
          method: "PATCH",
          json: { read: true },
        });
        expect(response.status).toBe(200);
      },
    );
    const job = s.enqueued.find((j) => j.type === "translate-article");
    if (!job) throw new Error("no job");

    await runJob({ ...s.platform, db: hook.db }, job);
    expect(hook.fired()).toBe(true);
    const rows = await s.platform.db
      .select({ seq: userArticles.seq })
      .from(userArticles)
      .where(eq(userArticles.userId, TEST_USER.id))
      .all();
    expect(new Set(rows.map((r) => r.seq)).size).toBe(rows.length);
    const a1 = await sync(s.platform, undefined, a0.cursor);
    const item = a1.articles.find((a) => a.id === en);
    expect(item?.readAt).not.toBeNull();
    expect(item?.translation).toMatchObject({ status: "translated", title: JA_TITLE });
  });
});

describe("本文を訳す（docs/decisions/translation.md の 3、10、13）", () => {
  /** 訳した本文を GET で取る */
  async function getTranslation(s: Setup, id: string) {
    const response = await requestApp(s.platform, `/api/v1/articles/${id}/translation`);
    expect(response.status).toBe(200);
    return (await response.json()) as {
      title: string | null;
      content: string | null;
      contentSource: string | null;
    };
  }

  /** 送った本文の断片（Claude API の要求の中の JSON） */
  function sentSegments(s: Setup) {
    const request = JSON.parse(s.claude[0]?.body ?? "{}") as { messages: { content: string }[] };
    return (
      JSON.parse(request.messages[0]?.content ?? "{}") as {
        segments: { id: string; text: string }[];
      }
    ).segments;
  }

  const tags = (html: string, name: string) =>
    html.match(new RegExp(`<${name}[\\s>]`, "g"))?.length ?? 0;

  /** 本文の断片には「訳:」を付け、タイトルと要約は決まった訳を返す */
  const prefix = (segment: { id: string; text: string }) =>
    segment.id === "title"
      ? JA_TITLE
      : segment.id === "summary"
        ? JA_SUMMARY
        : `訳:${segment.text}`;

  async function translate(s: Setup, reply?: Reply) {
    await maintain(s.platform);
    const id = await articleId(s.platform, "en");
    s.replies.push(reply ?? { transform: prefix });
    expect((await request(s, id)).response.status).toBe(202);
    await runQueuedTranslation(s);
    return id;
  }

  it("タグ・URL・コードの中身を送らず、訳した本文は元の構造とリンク・画像・コードを保つ", async () => {
    const s = await setup({ body: ARTICLE_BODY });
    const id = await translate(s);
    const sent = sentSegments(s);
    const body = sent.filter((segment) => segment.id.startsWith("b"));
    expect(body.map((segment) => segment.text)).toContain("Why codemods");
    const text = JSON.stringify(body);
    expect(text).not.toMatch(/[<>]/);
    expect(text).not.toContain("martinfowler.com");
    expect(text).not.toContain("npx jscodeshift");
    expect(text).not.toContain("jscodeshift</code>");

    const got = await getTranslation(s, id);
    expect(got.contentSource).toBe("feed");
    const content = got.content ?? "";
    for (const name of ["h2", "p", "figure", "figcaption", "ul", "li", "table", "th", "td"]) {
      expect(tags(content, name), name).toBe(tags(ARTICLE_BODY, name));
    }
    expect(tags(content, "blockquote")).toBe(1);
    expect(content).toContain("<h2>訳:Why codemods</h2>");
    expect(content).toContain("<td>訳:jscodeshift</td>");
    expect(content).toContain("<blockquote><p>訳:Automate the boring parts.</p></blockquote>");
    // リンクと強調は元の位置に、コードは中身ごと戻る
    expect(content).toMatch(
      /訳:Large codebases change their APIs often\. A <a href="https:\/\/martinfowler\.com\/bliki\/Refactoring\.html"[^>]*>refactoring<\/a> applied by hand is <strong>slow<\/strong> and <em>error-prone<\/em>\./,
    );
    expect(content).toContain("<li>訳:Rewrite it with <code>jscodeshift</code></li>");
    expect(content).toContain("<pre><code>npx jscodeshift -t transform.js src/</code></pre>");
    expect(content).toContain("訳:Run the tests after every change.<br>Then commit.");
    // 画像は中継の URL に書き換えて返す
    expect(content).toMatch(/<img src="\/api\/v1\/images\?[^"]+" alt="Flow of a codemod">/);
  });

  it("印が崩れた断片と返ってこなかった断片は原文のまま残し、ほかの断片は訳す", async () => {
    const s = await setup({ body: ARTICLE_BODY });
    const id = await translate(s, {
      transform: (segment) => {
        if (segment.text.startsWith("Large codebases")) return "印を落とした訳";
        if (segment.text === "How a codemod runs") return undefined;
        return prefix(segment);
      },
    });
    const content = (await getTranslation(s, id)).content ?? "";
    expect(content).toContain("Large codebases change their APIs often.");
    expect(content).not.toContain("印を落とした訳");
    expect(content).toContain("<figcaption>How a codemod runs</figcaption>");
    expect(content).toContain("<h2>訳:Why codemods</h2>");
  });

  it("訳の中のタグの文字列は、要素にならず文字として残る", async () => {
    const s = await setup({ body: "<p>Hello codemods</p>" });
    const id = await translate(s, {
      transform: (segment) =>
        segment.id.startsWith("b")
          ? '<script>alert(1)</script><img src=x onerror="y">'
          : prefix(segment),
    });
    const content = (await getTranslation(s, id)).content ?? "";
    expect(content).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(content).not.toMatch(/<script|<img/);
  });

  // 判定の偽物が英語と分かるよう「Codemods 」で始める（9 文字）
  const longText = (length: number) => `Codemods ${"a".repeat(length - 9)}`;

  it("送る本文の文字が 60,000 ちょうどなら本文も訳す", async () => {
    const exact = await setup({ body: `<p>${longText(60_000)}</p>` });
    const exactId = await translate(exact);
    expect((await getTranslation(exact, exactId)).content).toBe(`<p>訳:${longText(60_000)}</p>`);
  });

  it("送る本文の文字が 60,001 なら本文を訳さず、タイトルと要約だけを訳す", async () => {
    const over = await setup({ body: `<p>${longText(60_001)}</p>` });
    const overId = await translate(over);
    expect(sentSegments(over).map((segment) => segment.id)).toEqual(["title", "summary"]);
    const got = await getTranslation(over, overId);
    expect(got).toMatchObject({ title: JA_TITLE, content: null, contentSource: null });
  });

  it("訳した本文をサニタイズして 256KB を超えたら、本文を置かずタイトルと要約だけを置く", async () => {
    const s = await setup({ body: "<p>Short codemods body</p>" });
    const id = await translate(s, {
      transform: (segment) => (segment.id.startsWith("b") ? "あ".repeat(90_000) : prefix(segment)),
    });
    expect(await getTranslation(s, id)).toMatchObject({
      title: JA_TITLE,
      content: null,
      contentSource: null,
    });
  });

  it("訳した本文がサニタイズしたあとでちょうど 256KB なら置き、1 バイト多ければ置かない", async () => {
    // <p></p> の 7 バイトを含めて、ちょうど 256KB にする
    const limit = 256 * 1024;
    const exact = await setup({ body: "<p>Short codemods body</p>" });
    const exactId = await translate(exact, {
      transform: (segment) =>
        segment.id.startsWith("b") ? "a".repeat(limit - 7) : prefix(segment),
    });
    const kept = await translationOf(exact.platform, exactId);
    expect(new TextEncoder().encode(kept?.content ?? "").length).toBe(limit);
  });

  it("訳した本文がサニタイズしたあとで 256KB を 1 バイト超えたら置かない", async () => {
    const limit = 256 * 1024;
    const over = await setup({ body: "<p>Short codemods body</p>" });
    const overId = await translate(over, {
      transform: (segment) =>
        segment.id.startsWith("b") ? "a".repeat(limit - 6) : prefix(segment),
    });
    expect(await translationOf(over.platform, overId)).toMatchObject({
      title: JA_TITLE,
      content: null,
    });
  });

  it("受け取った本文で容量を超えるなら、呼び直さずに untranslated に戻す", async () => {
    const s = await setup({ body: "<p>Short codemods body</p>" });
    await maintain(s.platform);
    const id = await articleId(s.platform, "en");
    await request(s, id);
    // 見積もり（送る文の倍と本文の HTML）には収まるが、受け取った本文は収まらない上限にする
    const usage = await readStorageUsage(s.platform.db);
    const platform = { ...s.platform, retentionConfig: { maxBytes: usage.bytes + 4000 } };
    s.replies.push({
      transform: (segment) => (segment.id.startsWith("b") ? "訳".repeat(5000) : prefix(segment)),
    });
    const job = s.enqueued.find((j) => j.type === "translate-article");
    if (!job) throw new Error("no job");
    await runJob(platform, job);
    expect(s.claude).toHaveLength(1);
    expect(await translationOf(s.platform, id)).toMatchObject({
      status: "untranslated",
      content: null,
    });
  });

  it("ページの本文があればそれを訳し、出どころを page で返す", async () => {
    const s = await setup({ body: ARTICLE_BODY });
    await maintain(s.platform);
    const id = await articleId(s.platform, "en");
    // ページの本文が抜けた記事（抜き取りは Rust の処理で、テストの偽のページでは作りにくい）
    await recordExtractedPageContent(s.platform.db, {
      articleId: id,
      html: "<p>Page body about codemods.</p>",
      now: new Date(),
    });
    s.replies.push({ transform: prefix });
    await request(s, id);
    await runQueuedTranslation(s);
    expect(await getTranslation(s, id)).toMatchObject({
      content: "<p>訳:Page body about codemods.</p>",
      contentSource: "page",
    });
  });

  it("本文のない記事は、タイトルと要約だけを訳し、本文がないことが分かる", async () => {
    const s = await setup();
    const id = await translate(s);
    expect(sentSegments(s).map((segment) => segment.id)).toEqual(["title", "summary"]);
    expect(await getTranslation(s, id)).toMatchObject({
      title: JA_TITLE,
      content: null,
      contentSource: null,
    });
  });

  it("訳した本文の大きさを保存容量に入れる", async () => {
    const s = await setup({ body: ARTICLE_BODY });
    await maintain(s.platform);
    const id = await articleId(s.platform, "en");
    const decided = (await readStorageUsage(s.platform.db)).bytes;
    s.replies.push({ transform: prefix });
    await request(s, id);
    await runQueuedTranslation(s);
    const row = await translationOf(s.platform, id);
    const bytes = (text: string | null | undefined) => new TextEncoder().encode(text ?? "").length;
    expect(row?.content).not.toBeNull();
    const translatedBytes =
      bytes(row?.title) + bytes(row?.summary) + bytes(row?.model) + bytes(row?.content);
    const after = (await readStorageUsage(s.platform.db)).bytes;
    expect(after - decided).toBe(translatedBytes);

    // 訳文の行を消すと、本文の分も一緒に引く
    await s.platform.db
      .delete(articleTranslations)
      .where(eq(articleTranslations.articleId, id))
      .run();
    expect(after - (await readStorageUsage(s.platform.db)).bytes).toBe(512 + translatedBytes);
  });
});

describe("翻訳に使うモデルを選ぶ（docs/decisions/translation.md の 9）", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const sentModels = (s: Setup) =>
    s.claude.map((sent) => (JSON.parse(sent.body) as { model: string }).model);

  /** その場で訳してもらい、仕事を動かす（訳せなければ untranslated に戻り、また求められる） */
  async function translateOnce(s: Setup, id: string) {
    await request(s, id);
    await runQueuedTranslation(s);
    s.enqueued.length = 0;
  }

  const invalidRequest: Reply = { status: 400, errorType: "invalid_request_error" };

  it("一覧の claude-sonnet- のうち、作られた日がいちばん新しいもので送る", async () => {
    const s = await setup();
    await maintain(s.platform);
    await translateOnce(s, await articleId(s.platform, "en"));
    expect(sentModels(s)).toEqual(["claude-sonnet-5-5"]);
  });

  it("既定と違うモデルが新しく出ていれば、それを選ぶ。ほかの種類はもっと新しくても選ばない", async () => {
    const s = await setup({
      models: () =>
        modelsResponse([
          modelInfo("claude-sonnet-5-5", "2026-06-01T00:00:00Z"),
          modelInfo("claude-opus-6", "2026-10-01T00:00:00Z"),
          modelInfo("claude-sonnet-6", "2026-09-01T00:00:00Z"),
          modelInfo("claude-haiku-6", "2026-11-01T00:00:00Z"),
        ]),
    });
    await maintain(s.platform);
    const id = await articleId(s.platform, "en");
    await translateOnce(s, id);
    expect(sentModels(s)).toEqual(["claude-sonnet-6"]);
    expect(await translationOf(s.platform, id)).toMatchObject({
      status: "translated",
      model: "claude-sonnet-6",
    });
  });

  it("段階のモデルをモデルの ID で書くと、一覧を見ずにそのモデルで送る", async () => {
    // 3 つの段階をすべてモデルの ID で固定すると、一覧を取らない
    const s = await setup({
      env: {
        TRANSLATION_MODEL: "claude-sonnet-4-5",
        TRANSLATION_LONG_MODEL: "claude-haiku-4-5",
        RETRANSLATION_MODEL: "claude-opus-4-5",
      },
    });
    await maintain(s.platform);
    await translateOnce(s, await articleId(s.platform, "en"));
    expect(sentModels(s)).toEqual(["claude-sonnet-4-5"]);
    expect(s.models.requests).toBe(0);
  });

  const failingModels = () =>
    Response.json({ type: "error", error: { type: "api_error", message: "x" } }, { status: 500 });

  it("一覧を一度も取れていなければ、コードの既定を使い、ログに出す", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = await setup({ models: failingModels });
    await maintain(s.platform);
    await translateOnce(s, await articleId(s.platform, "en"));
    expect(sentModels(s)).toEqual([DEFAULT_FAMILY_MODELS.sonnet]);
    expect(warn).toHaveBeenCalledWith("could not list the translation models", expect.anything());
  });

  it("一覧を取れたあとに取り直しが失敗したら、前に選んだものを使う", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = await setup({
      models: () => modelsResponse([modelInfo("claude-sonnet-6", "2026-09-01T00:00:00Z")]),
    });
    await maintain(s.platform);
    const id = await articleId(s.platform, "en");
    // 1 回目は断られて untranslated に戻る（もう一度求められる）
    s.replies.push(invalidRequest);
    await translateOnce(s, id);
    s.models.reply = failingModels;
    s.clock.ms += DAY;
    await translateOnce(s, id);
    expect(s.models.requests).toBe(2);
    expect(sentModels(s)).toEqual(["claude-sonnet-6", "claude-sonnet-6"]);
    expect(await translationOf(s.platform, id)).toMatchObject({
      status: "translated",
      model: "claude-sonnet-6",
    });
  });

  it("新しいモデルで、まだ訳せていないうちに 400 が続けて 3 件起きたら、次の要求から 1 つ前のモデルで送り、ログに出す", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = await setup({
      models: () =>
        modelsResponse([
          modelInfo("claude-sonnet-6", "2026-09-01T00:00:00Z"),
          modelInfo("claude-sonnet-5-5", "2026-06-01T00:00:00Z"),
        ]),
    });
    await maintain(s.platform);
    const id = await articleId(s.platform, "en");
    s.replies.push(invalidRequest, invalidRequest, invalidRequest);
    for (let i = 0; i < 3; i++) await translateOnce(s, id);
    expect(warn).toHaveBeenCalledWith(
      "excluded a translation model after repeated invalid requests",
      { model: "claude-sonnet-6", next: "claude-sonnet-5-5" },
    );
    await translateOnce(s, id);
    expect(sentModels(s)).toEqual([
      "claude-sonnet-6",
      "claude-sonnet-6",
      "claude-sonnet-6",
      "claude-sonnet-5-5",
    ]);
    expect(await translationOf(s.platform, id)).toMatchObject({
      status: "translated",
      model: "claude-sonnet-5-5",
    });
    // 1 日たって一覧を取り直しても、外したモデルは選ばない
    s.clock.ms += DAY;
    await translateOnce(s, await articleId(s.platform, "und"));
    expect(s.models.requests).toBe(2);
    expect(sentModels(s).at(-1)).toBe("claude-sonnet-5-5");
  });

  it("2 件で止まったり、間に 1 件でも訳せていたりすると、外さない", async () => {
    const s = await setup({
      models: () =>
        modelsResponse([
          modelInfo("claude-sonnet-6", "2026-09-01T00:00:00Z"),
          modelInfo("claude-sonnet-5-5", "2026-06-01T00:00:00Z"),
        ]),
    });
    await maintain(s.platform);
    const id = await articleId(s.platform, "en");
    // 2 件で止まる
    s.replies.push(invalidRequest, invalidRequest);
    for (let i = 0; i < 2; i++) await translateOnce(s, id);
    // 訳せた
    await translateOnce(s, id);
    expect(await translationOf(s.platform, id)).toMatchObject({
      status: "translated",
      model: "claude-sonnet-6",
    });
    expect(sentModels(s)).toEqual(["claude-sonnet-6", "claude-sonnet-6", "claude-sonnet-6"]);
  });

  it("1 日たつと一覧を取り直し、新しいモデルが加わっていればそれを使う。1 日たつまでは取り直さない", async () => {
    let list = [modelInfo("claude-sonnet-6", "2026-09-01T00:00:00Z")];
    const s = await setup({ models: () => modelsResponse(list) });
    await maintain(s.platform);
    const id = await articleId(s.platform, "en");
    s.replies.push(invalidRequest);
    await translateOnce(s, id);
    expect(s.models.requests).toBe(1);

    list = [...list, modelInfo("claude-sonnet-7", "2026-11-01T00:00:00Z")];
    s.clock.ms += DAY - 1;
    s.replies.push(invalidRequest);
    await translateOnce(s, id);
    expect(s.models.requests).toBe(1);

    s.clock.ms += 1;
    await translateOnce(s, id);
    expect(s.models.requests).toBe(2);
    expect(sentModels(s)).toEqual(["claude-sonnet-6", "claude-sonnet-6", "claude-sonnet-7"]);
  });

  /** claude-sonnet-6（いちばん新しい）、claude-sonnet-5-5、claude-sonnet-5 の一覧 */
  const threeSonnets = () =>
    modelsResponse([
      modelInfo("claude-sonnet-6", "2026-09-01T00:00:00Z"),
      modelInfo("claude-sonnet-5-5", "2026-06-01T00:00:00Z"),
      modelInfo("claude-sonnet-5", "2026-01-01T00:00:00Z"),
    ]);

  it("一覧は、使えるモデル（active）だけを取る", async () => {
    const s = await setup();
    await maintain(s.platform);
    await translateOnce(s, await articleId(s.platform, "en"));
    // SDK は配列の指定を lifecycle[] で送る
    expect(s.models.urls[0]?.searchParams.getAll("lifecycle[]")).toEqual(["active"]);
  });

  it("外したあとの次のモデルでも 400 が続けば、それも外して次に新しいものを使う", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = await setup({ models: threeSonnets });
    await maintain(s.platform);
    const id = await articleId(s.platform, "en");
    s.replies.push(...Array.from({ length: 6 }, () => invalidRequest));
    for (let i = 0; i < 7; i++) await translateOnce(s, id);
    expect(sentModels(s)).toEqual([
      ...Array.from({ length: 3 }, () => "claude-sonnet-6"),
      ...Array.from({ length: 3 }, () => "claude-sonnet-5-5"),
      "claude-sonnet-5",
    ]);
  });

  it("支払いの問題（billing_error）の 400 は、要求の形の誤りとして数えない", async () => {
    const s = await setup({ models: threeSonnets });
    await maintain(s.platform);
    const id = await articleId(s.platform, "en");
    const billing: Reply = { status: 400, errorType: "billing_error" };
    s.replies.push(billing, billing, billing);
    for (let i = 0; i < 4; i++) await translateOnce(s, id);
    expect(sentModels(s)).toEqual(Array.from({ length: 4 }, () => "claude-sonnet-6"));
  });

  it("400 の間にほかの結果（拒否など）が入ると、続けて数えない", async () => {
    const s = await setup({ models: threeSonnets });
    await maintain(s.platform);
    const id = await articleId(s.platform, "en");
    s.replies.push(invalidRequest, invalidRequest, { stop: "refusal" }, invalidRequest);
    for (let i = 0; i < 5; i++) await translateOnce(s, id);
    expect(sentModels(s)).toEqual(Array.from({ length: 5 }, () => "claude-sonnet-6"));
    expect(await translationOf(s.platform, id)).toMatchObject({
      status: "translated",
      model: "claude-sonnet-6",
    });
  });

  it("固定のモデル、一覧にほかの Sonnet がないとき、一覧を取れずに既定を使うときは、400 が続いても外さない", async () => {
    for (const options of [
      { env: { TRANSLATION_MODEL: "claude-sonnet-4-5" } },
      { models: () => modelsResponse([modelInfo("claude-sonnet-6", "2026-09-01T00:00:00Z")]) },
      {
        models: () =>
          Response.json(
            { type: "error", error: { type: "api_error", message: "x" } },
            { status: 500 },
          ),
      },
      // Sonnet が 1 つもない一覧も、既定を使う
      { models: () => modelsResponse([modelInfo("claude-opus-6", "2026-09-01T00:00:00Z")]) },
    ]) {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      await testDb.exec("DELETE FROM feeds");
      const s = await setup(options);
      await maintain(s.platform);
      const id = await articleId(s.platform, "en");
      s.replies.push(invalidRequest, invalidRequest, invalidRequest);
      for (let i = 0; i < 4; i++) await translateOnce(s, id);
      const models = sentModels(s);
      expect(new Set(models).size).toBe(1);
      expect(models).toHaveLength(4);
    }
  });
});

describe("段階ごとのモデルと思考量（docs/decisions/translation.md の 9）", () => {
  /** Unicode の文字でちょうど n 文字の本文（送る文の長さ）。英語と判定される語を入れる */
  const bodyOf = (n: number) => {
    const body = `<p>Codemods ${"x".repeat(n - "Codemods ".length)}</p>`;
    expect(splitBody(body).length).toBe(n);
    return body;
  };
  /** 送った要求のモデル、思考量、代わりのモデルの指定 */
  const sentParams = (params: Record<string, unknown>) => {
    const p = params as { model: string; output_config: { effort: string }; fallbacks?: string };
    return { model: p.model, effort: p.output_config.effort, fallbacks: p.fallbacks ?? null };
  };
  const sentCalls = (s: Setup) => s.claude.map((c) => sentParams(JSON.parse(c.body)));
  /** バッチの記事ごとの要求（custom_id → モデルと思考量） */
  const batchParams = (s: Setup, index: number) =>
    Object.fromEntries(
      (s.batches.list[index]?.requests ?? []).map((r) => [r.custom_id, sentParams(r.params)]),
    );

  it("既定では、バッチの中で送る本文が 3,000 文字以上の記事は Haiku・low、ほかは Sonnet・medium で送る。代わりのモデルは付けない", async () => {
    const s = await setup({ body: bodyOf(3000), extraEnglish: 1 });
    await maintain(s.platform);
    const en = await articleId(s.platform, "en");
    const other = await articleId(s.platform, "en-0");
    expect(s.batches.list).toHaveLength(1);
    expect(batchParams(s, 0)).toEqual({
      [en]: { model: "claude-haiku-5-5", effort: "low", fallbacks: null },
      [other]: { model: "claude-sonnet-5-5", effort: "medium", fallbacks: null },
    });
  });

  it("送る本文がちょうど閾値の記事は長文、1 文字少なければ通常。閾値は TRANSLATION_LONG_THRESHOLD_CHARS で変えられる", async () => {
    for (const [env, chars, model] of [
      [{}, 2999, "claude-sonnet-5-5"],
      [{ TRANSLATION_LONG_THRESHOLD_CHARS: "2999" }, 2999, "claude-haiku-5-5"],
      [{ TRANSLATION_LONG_THRESHOLD_CHARS: "3001" }, 3000, "claude-sonnet-5-5"],
    ] as const) {
      await testDb.exec("DELETE FROM feeds");
      const s = await setup({ body: bodyOf(chars), env });
      await maintain(s.platform);
      const en = await articleId(s.platform, "en");
      expect(batchParams(s, 0)[en]?.model).toBe(model);
    }
  });

  it("その場の翻訳は、長い記事でも Sonnet・medium で、代わりのモデルを付けて送る", async () => {
    const s = await setup({ body: bodyOf(5000) });
    await maintain(s.platform);
    await request(s, await articleId(s.platform, "en"));
    await runQueuedTranslation(s);
    expect(sentCalls(s)).toEqual([
      { model: "claude-sonnet-5-5", effort: "medium", fallbacks: "default" },
    ]);
  });

  it("訳し直しは、長い記事でも Opus・medium で、代わりのモデルを付けて送る", async () => {
    const s = await setup({ body: bodyOf(5000) });
    const id = await translatedArticle(s);
    await retranslate(s, id);
    s.replies.push(opusReply);
    await runQueuedTranslation(s);
    expect(sentCalls(s)).toEqual([
      { model: "claude-opus-5-5", effort: "medium", fallbacks: "default" },
    ]);
  });

  it("環境変数で段階のモデルと思考量を変えると、そのモデルと思考量で送る", async () => {
    const s = await setup({
      body: bodyOf(3000),
      extraEnglish: 1,
      env: {
        TRANSLATION_MODEL: "OPUS",
        TRANSLATION_EFFORT: "high",
        TRANSLATION_LONG_MODEL: "sonnet",
        TRANSLATION_LONG_EFFORT: "Medium",
        RETRANSLATION_MODEL: "claude-opus-4-5",
        RETRANSLATION_EFFORT: "max",
      },
    });
    await maintain(s.platform);
    const en = await articleId(s.platform, "en");
    const other = await articleId(s.platform, "en-0");
    expect(batchParams(s, 0)).toEqual({
      [en]: { model: "claude-sonnet-5-5", effort: "medium", fallbacks: null },
      [other]: { model: "claude-opus-5-5", effort: "high", fallbacks: null },
    });
    await request(s, other);
    await runQueuedTranslation(s);
    s.enqueued.length = 0;
    await retranslate(s, other);
    s.replies.push(opusReply);
    await runQueuedTranslation(s);
    expect(sentCalls(s)).toEqual([
      { model: "claude-opus-5-5", effort: "high", fallbacks: "default" },
      { model: "claude-opus-4-5", effort: "max", fallbacks: "default" },
    ]);
  });

  it("代わりのモデルのないモデル（Haiku）でその場で訳すと、代わりのモデルを付けず、拒否されたらその回で untranslated になる", async () => {
    const s = await setup({ env: { TRANSLATION_MODEL: "haiku" } });
    await maintain(s.platform);
    const id = await articleId(s.platform, "en");
    s.replies.push({
      text: "",
      stop: "refusal",
      stopDetails: { type: "refusal", category: "cyber", explanation: null },
    });
    await request(s, id);
    await runQueuedTranslation(s);
    expect(sentCalls(s)).toEqual([
      { model: "claude-haiku-5-5", effort: "medium", fallbacks: null },
    ]);
    expect(s.claude[0]?.headers.get("anthropic-beta") ?? "").not.toContain("server-side-fallback");
    expect(await translationOf(s.platform, id)).toMatchObject({
      status: "untranslated",
      failureKind: "refused",
      failureCategory: "cyber",
      failureStage: "on_demand",
    });
  });

  it("段階の思考量を受け付けないモデルは、新しくても選ばない", async () => {
    const s = await setup({
      body: bodyOf(3000),
      extraEnglish: 1,
      models: () =>
        modelsResponse([
          // medium を受け付けない新しい Sonnet と、思考量の分からない新しい Haiku
          modelInfo("claude-sonnet-6", "2026-09-01T00:00:00Z", ["low", "high"]),
          modelInfo("claude-sonnet-5-5", "2026-06-01T00:00:00Z"),
          { ...modelInfo("claude-haiku-6", "2026-10-01T00:00:00Z"), capabilities: null },
          modelInfo("claude-haiku-5-5", "2026-05-01T00:00:00Z", ["low"]),
        ]),
    });
    await maintain(s.platform);
    const en = await articleId(s.platform, "en");
    const other = await articleId(s.platform, "en-0");
    // 長文（low）は思考量の分かる Haiku 5.5 を選び、通常（medium）は Sonnet 5.5 を選ぶ
    expect(batchParams(s, 0)).toEqual({
      [en]: { model: "claude-haiku-5-5", effort: "low", fallbacks: null },
      [other]: { model: "claude-sonnet-5-5", effort: "medium", fallbacks: null },
    });
  });

  it("段階の思考量を受け付けるモデルが一覧にないときは、コードの既定で送り、エラーをログに出す", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const s = await setup({
      models: () => modelsResponse([modelInfo("claude-sonnet-6", "2026-09-01T00:00:00Z", ["low"])]),
    });
    await maintain(s.platform);
    const en = await articleId(s.platform, "en");
    expect(batchParams(s, 0)[en]?.model).toBe("claude-sonnet-5-5");
    expect(error).toHaveBeenCalledWith("no translation model in the list matches the tier", {
      prefix: "claude-sonnet-",
      effort: "medium",
      using: "claude-sonnet-5-5",
    });
    // 同じ一覧を使う間は、出し直さない
    const logged = error.mock.calls.length;
    await request(s, en);
    await runQueuedTranslation(s);
    expect(error).toHaveBeenCalledTimes(logged);
  });

  it("バッチの結果ごとの誤りはその記事のモデルに数え、ほかの段階の誤りと合わせて 3 件で外す", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = await setup({
      body: bodyOf(10),
      extraEnglish: 1,
      models: () =>
        modelsResponse([
          modelInfo("claude-sonnet-6", "2026-09-01T00:00:00Z"),
          modelInfo("claude-sonnet-5-5", "2026-06-01T00:00:00Z"),
          modelInfo("claude-opus-6", "2026-09-01T00:00:00Z"),
          modelInfo("claude-opus-5-5", "2026-06-01T00:00:00Z"),
        ]),
      // 本文のある記事は長文（Sonnet）、ない記事は通常（Opus）。訳し直しも Sonnet
      env: {
        TRANSLATION_MODEL: "opus",
        TRANSLATION_LONG_MODEL: "sonnet",
        TRANSLATION_LONG_THRESHOLD_CHARS: "1",
        RETRANSLATION_MODEL: "sonnet",
      },
    });
    await maintain(s.platform);
    const en = await articleId(s.platform, "en");
    const other = await articleId(s.platform, "en-0");
    expect(batchParams(s, 0)).toMatchObject({
      [en]: { model: "claude-sonnet-6" },
      [other]: { model: "claude-opus-6" },
    });
    // 通常の段階（Opus 6）で訳しておく
    await request(s, other);
    await runQueuedTranslation(s);
    expect(await translationOf(s.platform, other)).toMatchObject({ status: "translated" });
    // 品質優先の段階で、Sonnet 6 に 2 件
    const invalid: Reply = { status: 400, errorType: "invalid_request_error" };
    for (let i = 0; i < 2; i++) {
      s.enqueued.length = 0;
      await retranslate(s, other);
      s.replies.push(invalid);
      await runQueuedTranslation(s);
    }
    expect(warn).not.toHaveBeenCalledWith(
      "excluded a translation model after repeated invalid requests",
      expect.anything(),
    );
    // 長文の記事が要求の形の誤りで返ると、Sonnet 6 に 3 件目。通常の段階の Opus 6 は外れない
    const batch = s.batches.list[0];
    if (!batch) throw new Error("no batch");
    batch.ended = true;
    batch.results = new Map([
      [
        en,
        {
          type: "errored",
          error: { type: "error", error: { type: "invalid_request_error", message: "x" } },
        },
      ],
    ]);
    await maintain(s.platform);
    expect(warn).toHaveBeenCalledWith(
      "excluded a translation model after repeated invalid requests",
      { model: "claude-sonnet-6", next: "claude-sonnet-5-5" },
    );
    // モデルを外す判断に数えたので、回数には数えず、同じ手入れで次に新しいモデルで送り直す
    expect((await translationOf(s.platform, en))?.batchAttempts).toBe(0);
    expect(batchParams(s, 1)[en]?.model).toBe("claude-sonnet-5-5");
    s.enqueued.length = 0;
    await retranslate(s, other);
    await runQueuedTranslation(s);
    expect(sentCalls(s).map((c) => c.model)).toEqual([
      "claude-opus-6",
      "claude-sonnet-6",
      "claude-sonnet-6",
      "claude-sonnet-5-5",
    ]);
  });

  it("固定のモデルへの要求の形の誤りは、外す判断に数えず、同じモデルを系列で選ぶほかの段階からも外さない", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = await setup({
      body: bodyOf(10),
      extraEnglish: 1,
      models: () =>
        modelsResponse([
          modelInfo("claude-sonnet-6", "2026-09-01T00:00:00Z"),
          modelInfo("claude-sonnet-5-5", "2026-06-01T00:00:00Z"),
        ]),
      env: {
        TRANSLATION_MODEL: "claude-sonnet-6",
        TRANSLATION_LONG_MODEL: "sonnet",
        TRANSLATION_LONG_THRESHOLD_CHARS: "1",
      },
    });
    await maintain(s.platform);
    const en = await articleId(s.platform, "en");
    const other = await articleId(s.platform, "en-0");
    expect(batchParams(s, 0)[en]?.model).toBe("claude-sonnet-6");
    const invalid: Reply = { status: 400, errorType: "invalid_request_error" };
    for (let i = 0; i < 3; i++) {
      s.replies.push(invalid);
      await request(s, other);
      await runQueuedTranslation(s);
      s.enqueued.length = 0;
    }
    expect(warn).not.toHaveBeenCalledWith(
      "excluded a translation model after repeated invalid requests",
      expect.anything(),
    );
    const batch = s.batches.list[0];
    if (!batch) throw new Error("no batch");
    batch.ended = true;
    batch.results = new Map([[en, { type: "expired" }]]);
    await maintain(s.platform);
    expect(batchParams(s, 1)[en]?.model).toBe("claude-sonnet-6");
  });

  it("一覧を取れずに既定のモデルで送る間の要求の形の誤りは、外す判断に数えず、一覧が取れたら既定のモデルも選べる", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = await setup({
      models: () =>
        Response.json(
          { type: "error", error: { type: "api_error", message: "x" } },
          { status: 500 },
        ),
    });
    await maintain(s.platform);
    const id = await articleId(s.platform, "en");
    const invalid: Reply = { status: 400, errorType: "invalid_request_error" };
    for (let i = 0; i < 3; i++) {
      s.replies.push(invalid);
      await request(s, id);
      await runQueuedTranslation(s);
      s.enqueued.length = 0;
    }
    // 1 時間たって一覧が取れると、既定と同じモデルがいちばん新しい
    s.models.reply = () =>
      modelsResponse([
        modelInfo("claude-sonnet-5-5", "2026-06-01T00:00:00Z"),
        modelInfo("claude-sonnet-5", "2026-01-01T00:00:00Z"),
      ]);
    s.clock.ms += 60 * 60 * 1000;
    await request(s, id);
    await runQueuedTranslation(s);
    expect(sentCalls(s).map((c) => c.model)).toEqual(Array(4).fill("claude-sonnet-5-5"));
  });

  it("モデルを外す判断はモデルごとで、ある段階で外したモデルは、同じ系列を選ぶほかの段階でも使わない", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = await setup({
      extraEnglish: 1,
      models: () =>
        modelsResponse([
          modelInfo("claude-sonnet-6", "2026-09-01T00:00:00Z"),
          modelInfo("claude-sonnet-5-5", "2026-06-01T00:00:00Z"),
        ]),
      env: { RETRANSLATION_MODEL: "sonnet", RETRANSLATION_EFFORT: "high" },
    });
    await maintain(s.platform);
    const first = await articleId(s.platform, "en-0");
    const id = await articleId(s.platform, "en");
    const invalid: Reply = { status: 400, errorType: "invalid_request_error" };
    // 通常の段階で、新しい Sonnet への要求の形の誤りが続けて 3 件
    for (let i = 0; i < 3; i++) {
      s.replies.push(invalid);
      await request(s, first);
      await runQueuedTranslation(s);
      s.enqueued.length = 0;
    }
    expect(warn).toHaveBeenCalledWith(
      "excluded a translation model after repeated invalid requests",
      { model: "claude-sonnet-6", next: "claude-sonnet-5-5" },
    );
    await request(s, id);
    await runQueuedTranslation(s);
    s.enqueued.length = 0;
    // 品質優先の段階も、外したモデルを使わない
    await retranslate(s, id);
    s.replies.push(opusReply);
    await runQueuedTranslation(s);
    expect(sentCalls(s).map((c) => c.model)).toEqual([
      "claude-sonnet-6",
      "claude-sonnet-6",
      "claude-sonnet-6",
      "claude-sonnet-5-5",
      "claude-sonnet-5-5",
    ]);
    expect(sentCalls(s).at(-1)?.effort).toBe("high");
  });

  it("モデルが 2 つのバッチを作るときの要求の形の誤りは、どちらのモデルにも数えない", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = await setup({
      body: bodyOf(3000),
      extraEnglish: 1,
      models: () =>
        modelsResponse([
          modelInfo("claude-sonnet-6", "2026-09-01T00:00:00Z"),
          modelInfo("claude-sonnet-5-5", "2026-06-01T00:00:00Z"),
          modelInfo("claude-haiku-6", "2026-09-01T00:00:00Z"),
          modelInfo("claude-haiku-5-5", "2026-06-01T00:00:00Z"),
        ]),
    });
    for (let i = 0; i < 3; i++) {
      s.batches.createFailure = () =>
        Response.json(
          { type: "error", error: { type: "invalid_request_error", message: "x" } },
          { status: 400 },
        );
      await maintain(s.platform);
    }
    s.batches.createFailure = null;
    await maintain(s.platform);
    const models = Object.values(batchParams(s, 0)).map((p) => p.model);
    expect(models.sort()).toEqual(["claude-haiku-6", "claude-sonnet-6"]);
  });
});

describe("バッチで訳す（docs/decisions/translation.md の 4）", () => {
  const maintainWith = (platform: Platform) => runJob(platform, { type: "maintain-translations" });

  /** 送ったバッチの記事の ID（custom_id） */
  const sentIds = (batch: FakeBatch | undefined) => batch?.requests.map((r) => r.custom_id) ?? [];

  it("queued の記事だけを 1 つのバッチで送り、終わったら訳文を書いて translated にする", async () => {
    const s = await setup({ body: "<p>Codemods change every call site.</p>" });
    s.batches.transform = (segment) =>
      segment.id === "b1" ? "コードモッドはすべての呼び出しを変える。" : defaultTransform(segment);
    const en = await articleId(s.platform, "en");
    await maintain(s.platform);
    expect(s.batches.list).toHaveLength(1);
    expect(sentIds(s.batches.list[0])).toEqual([en]);
    expect(s.claude).toHaveLength(0);

    // 送る中身は、その場の翻訳と同じ。代わりのモデルの指定は付けない
    const params = s.batches.list[0]?.requests[0]?.params ?? {};
    expect(params).toMatchObject({
      model: "claude-sonnet-5-5",
      output_config: { effort: "medium", format: { type: "json_schema" } },
    });
    expect(params).not.toHaveProperty("fallbacks");
    const sent = JSON.stringify(params);
    for (const secret of [FEED_HOST, "Martin Fowler", TEST_USER.id, TEST_USER.email]) {
      expect(sent).not.toContain(secret);
    }

    // まだ終わっていない。印を残して、次に見直す
    await maintain(s.platform);
    expect(s.batches.checks).toEqual([s.batches.list[0]?.id]);
    expect(await translationOf(s.platform, en)).toMatchObject({ status: "queued", title: null });
    expect(s.batches.list).toHaveLength(1);

    const batch = s.batches.list[0];
    if (batch) batch.ended = true;
    s.notified.length = 0;
    await maintain(s.platform);
    expect(await translationOf(s.platform, en)).toMatchObject({
      status: "translated",
      title: JA_TITLE,
      summary: JA_SUMMARY,
      content: "<p>コードモッドはすべての呼び出しを変える。</p>",
      contentSource: "feed",
      model: "claude-sonnet-5-5",
      batchKey: null,
      batchId: null,
    });
    expect(s.notified).toEqual([TEST_USER.id]);
    // 終わったバッチは、もう見にいかない
    const checks = s.batches.checks.length;
    await maintain(s.platform);
    expect(s.batches.checks).toHaveLength(checks);
  });

  it("上限ちょうどの 100 件は 1 つのバッチに入り、101 件目は次のバッチに入る", async () => {
    const s = await setup({ extraEnglish: 100 });
    // 英語の 101 件を、先に queued にしておく（手入れが 1 回に決めるのは 100 件まで）
    await decideTranslations(s.platform.db);
    await decideTranslations(s.platform.db);
    await maintain(s.platform);
    expect(s.batches.list.map((b) => b.requests.length)).toEqual([100]);
    await maintain(s.platform);
    expect(s.batches.list.map((b) => b.requests.length)).toEqual([100, 1]);
    const all = s.batches.list.flatMap((b) => sentIds(b));
    expect(new Set(all).size).toBe(101);
  });

  it("見にいくのは、印を付けたのが古い順に 10 個まで。見にいけなかったバッチは印を残す", async () => {
    const s = await setup({ extraEnglish: 10 });
    await maintain(s.platform);
    // 11 件を、それぞれ別のバッチに送ったことにする（古い順に 0〜10）
    const { results: rows } = await testDb
      .prepare(
        "SELECT article_id FROM article_translations WHERE status = 'queued' ORDER BY article_id",
      )
      .all<{ article_id: string }>();
    expect(rows).toHaveLength(11);
    s.batches.list.length = 0;
    for (const [i, row] of rows.entries()) {
      const id = `msgbatch_old_${i}`;
      s.batches.list.push({
        id,
        requests: [{ custom_id: row.article_id, params: {} }],
        ended: false,
      });
      await testDb.exec(
        `UPDATE article_translations SET batch_key = '${id}', batch_id = '${id}',
           batch_marked_at = ${Date.now() - (100 - i) * 1000} WHERE article_id = '${row.article_id}'`,
      );
    }
    s.batches.checks.length = 0;
    await maintain(s.platform);
    expect(s.batches.checks).toEqual(Array.from({ length: 10 }, (_, i) => `msgbatch_old_${i}`));

    // 見にいけない（5xx）ときは、印を残して次に見直す
    s.batches.checkFailure = () =>
      Response.json({ type: "error", error: { type: "api_error", message: "x" } }, { status: 500 });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await maintain(s.platform);
    const marked = await testDb
      .prepare("SELECT count(*) AS n FROM article_translations WHERE batch_id IS NOT NULL")
      .first<number>("n");
    expect(marked).toBe(11);
  });

  it("送ったあと、結果が返る前にその場で訳すと、あとで返ったバッチの結果は捨てられる", async () => {
    const s = await setup();
    s.batches.transform = (segment) => (segment.id === "title" ? "バッチの訳" : undefined);
    const en = await articleId(s.platform, "en");
    await maintain(s.platform);
    expect(sentIds(s.batches.list[0])).toEqual([en]);

    await request(s, en);
    await runQueuedTranslation(s);
    expect(await translationOf(s.platform, en)).toMatchObject({
      status: "translated",
      title: JA_TITLE,
      batchKey: null,
      batchId: null,
    });

    const batch = s.batches.list[0];
    if (batch) batch.ended = true;
    await maintain(s.platform);
    expect(await translationOf(s.platform, en)).toMatchObject({ title: JA_TITLE });
  });

  it("バッチを作る途中で落ちたら、1 時間たつまで送り直さず、たったら待ちに戻して送る", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = await setup();
    const en = await articleId(s.platform, "en");
    // 作れたかどうか分からない失敗（届かない。ID を書き留める前に落ちたのと同じく、印が残る）
    s.batches.createFailure = () => {
      throw new TypeError("fetch failed");
    };
    await maintain(s.platform);
    expect(await translationOf(s.platform, en)).toMatchObject({ status: "queued", batchId: null });
    expect((await translationOf(s.platform, en))?.batchKey).not.toBeNull();

    s.batches.createFailure = null;
    await maintain(s.platform);
    expect(s.batches.list).toHaveLength(0);

    // 1 時間たったことにする
    await testDb.exec(
      `UPDATE article_translations SET batch_marked_at = batch_marked_at - ${BATCH_MARK_TTL_MS}`,
    );
    await maintain(s.platform);
    expect(sentIds(s.batches.list[0])).toEqual([en]);
  });

  it("容量が足りなければ送らない。受け取ったあとで足りなければ印を残し、空いたら書く", async () => {
    const s = await setup();
    const en = await articleId(s.platform, "en");
    await decideTranslations(s.platform.db);
    const usage = await readStorageUsage(s.platform.db);
    const full = { ...s.platform, retentionConfig: { maxBytes: usage.bytes + 100 } };
    await maintainWith(full);
    expect(s.batches.list).toHaveLength(0);
    expect(await translationOf(s.platform, en)).toMatchObject({ status: "queued", batchKey: null });

    await maintain(s.platform);
    const batch = s.batches.list[0];
    if (batch) batch.ended = true;
    // 見積もりには収まるが、受け取った訳文は収まらない
    s.batches.transform = (segment) => (segment.id === "title" ? "訳".repeat(5000) : undefined);
    const now = await readStorageUsage(s.platform.db);
    await maintainWith({ ...s.platform, retentionConfig: { maxBytes: now.bytes + 2000 } });
    expect(await translationOf(s.platform, en)).toMatchObject({
      status: "queued",
      title: null,
      batchId: batch?.id,
    });

    await maintain(s.platform);
    expect(await translationOf(s.platform, en)).toMatchObject({
      status: "translated",
      title: "訳".repeat(5000),
      batchId: null,
    });
  });

  it("訳し終えると番号が進む。印を付けただけでは進まない", async () => {
    const s = await setup();
    const en = await articleId(s.platform, "en");
    const inbox = () =>
      s.platform.db.select().from(userArticles).where(eq(userArticles.articleId, en)).get();
    // 決める（queued になって番号が進む）だけの手入れ
    s.batches.createFailure = () =>
      Response.json({ type: "error", error: { type: "api_error", message: "x" } }, { status: 500 });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await maintain(s.platform);
    const decided = await inbox();
    s.batches.createFailure = null;
    await testDb.exec(
      `UPDATE article_translations SET batch_marked_at = batch_marked_at - ${BATCH_MARK_TTL_MS}`,
    );
    await maintain(s.platform);
    expect(s.batches.list).toHaveLength(1);
    expect((await inbox())?.seq).toBe(decided?.seq);

    const batch = s.batches.list[0];
    if (batch) batch.ended = true;
    await maintain(s.platform);
    expect((await inbox())?.seq).toBeGreaterThan(decided?.seq ?? Number.POSITIVE_INFINITY);
  });

  it("expired の記事と、もう見られないバッチの記事は、待ちに戻って次のバッチで送られる", async () => {
    const s = await setup({ extraEnglish: 1 });
    const en = await articleId(s.platform, "en");
    const other = await articleId(s.platform, "en-0");
    await maintain(s.platform);
    const first = s.batches.list[0];
    if (!first) throw new Error("no batch");
    first.ended = true;
    first.results = new Map([[en, { type: "expired" }]]);
    await maintain(s.platform);
    expect(await translationOf(s.platform, en)).toMatchObject({ status: "queued", title: null });
    expect(await translationOf(s.platform, other)).toMatchObject({ status: "translated" });
    expect(sentIds(s.batches.list[1])).toEqual([en]);

    const second = s.batches.list[1];
    if (second) second.gone = true;
    await maintain(s.platform);
    expect(sentIds(s.batches.list[2])).toEqual([en]);
  });

  it("その場の翻訳の最中や、その場で訳せなかった行にも、まだ訳文がなければバッチの結果を書く", async () => {
    const s = await setup({ extraEnglish: 1 });
    s.batches.transform = (segment) => (segment.id === "title" ? "バッチの訳" : undefined);
    const en = await articleId(s.platform, "en");
    const other = await articleId(s.platform, "en-0");
    await maintain(s.platform);
    // en はその場の翻訳の最中、other はその場で訳せず untranslated
    await request(s, en);
    const job = s.enqueued.find((j) => j.type === "translate-article");
    s.enqueued.length = 0;
    await request(s, other);
    s.replies.push({ status: 400, errorType: "invalid_request_error" });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await runQueuedTranslation(s);
    expect(await translationOf(s.platform, other)).toMatchObject({ status: "untranslated" });

    const batch = s.batches.list[0];
    if (batch) batch.ended = true;
    await maintain(s.platform);
    for (const id of [en, other]) {
      expect(await translationOf(s.platform, id)).toMatchObject({
        status: "translated",
        title: "バッチの訳",
        startedAt: null,
      });
    }
    // あとで終わったその場の翻訳の仕事は、書かない
    if (!job) throw new Error("no job");
    await runJob(s.platform, job);
    expect(await translationOf(s.platform, en)).toMatchObject({ title: "バッチの訳" });
  });

  it("結果を書く途中で落ちても、次の手入れで残りだけを書き、印を残さない", async () => {
    const s = await setup({ extraEnglish: 1 });
    const en = await articleId(s.platform, "en");
    const other = await articleId(s.platform, "en-0");
    await maintain(s.platform);
    const batch = s.batches.list[0];
    if (batch) batch.ended = true;
    // 1 件目を書いたあと、2 件目を書く文の前で落ちる
    let writes = 0;
    const hook = statementHook(
      (sql) =>
        sql.startsWith("update article_translations set status = 'translated'") && ++writes === 2,
      async () => {
        throw new Error("crashed");
      },
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await maintainWith({ ...s.platform, db: hook.db });
    expect(hook.fired()).toBe(true);
    const statuses = [await translationOf(s.platform, en), await translationOf(s.platform, other)];
    expect(statuses.filter((row) => row?.status === "translated")).toHaveLength(1);

    s.notified.length = 0;
    await maintain(s.platform);
    for (const id of [en, other]) {
      expect(await translationOf(s.platform, id)).toMatchObject({
        status: "translated",
        batchKey: null,
        batchId: null,
      });
    }
    expect(s.batches.list).toHaveLength(1);
    // 落ちたほうの記事は、印を残して次の手入れで書いた（送り直していない）。書いた記事を持つ人に知らせる
    expect(s.notified).toEqual([TEST_USER.id]);
  });

  it("手入れが重なっても、同じ記事を 2 つのバッチで送らない", async () => {
    const s = await setup({ extraEnglish: 3 });
    await decideTranslations(s.platform.db);
    await Promise.all([maintain(s.platform), maintain(s.platform)]);
    const sent = s.batches.list.flatMap((b) => sentIds(b));
    expect(sent).toHaveLength(4);
    expect(new Set(sent).size).toBe(4);
  });

  it("送ったあとでページの本文が抜けても、送ったフィードの本文で組み立てる。知らない ID の結果は使わない", async () => {
    const s = await setup({ body: "<p>Codemods change every call site.</p>" });
    s.batches.transform = (segment) =>
      segment.id === "b1" ? "コードモッドはすべての呼び出しを変える。" : defaultTransform(segment);
    const en = await articleId(s.platform, "en");
    await maintain(s.platform);
    await recordExtractedPageContent(s.platform.db, {
      articleId: en,
      html: "<p>A different page body.</p><p>Second paragraph.</p>",
      now: new Date(),
    });
    const batch = s.batches.list[0];
    if (!batch) throw new Error("no batch");
    batch.ended = true;
    batch.results = new Map([
      [
        "unknown-article",
        { type: "succeeded", message: messageJson("claude-sonnet-5-5", translated([])) },
      ],
    ]);
    batch.requests.push({ custom_id: "unknown-article", params: {} });
    await maintain(s.platform);
    expect(await translationOf(s.platform, en)).toMatchObject({
      status: "translated",
      content: "<p>コードモッドはすべての呼び出しを変える。</p>",
      contentSource: "feed",
    });
  });

  it("送ったときと本文の分け方が違えば（指紋が合わない）、書かずに待ちに戻し、次のバッチで送り直す", async () => {
    const s = await setup({ body: "<p>Codemods change every call site.</p>" });
    s.batches.transform = (segment) =>
      segment.id === "b1" ? "コードモッドはすべての呼び出しを変える。" : defaultTransform(segment);
    const en = await articleId(s.platform, "en");
    await maintain(s.platform);
    // 送ったあとで分け方が変わった（その間のデプロイ）ことにする
    await testDb.exec(
      `UPDATE article_translations SET batch_body_hash = 'changed' WHERE article_id = '${en}'`,
    );
    const batch = s.batches.list[0];
    if (batch) batch.ended = true;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await maintain(s.platform);
    // 書かずに待ちに戻し、同じ手入れの中で、今の分け方で送り直す
    expect(await translationOf(s.platform, en)).toMatchObject({ status: "queued", title: null });
    expect(sentIds(s.batches.list[1])).toEqual([en]);
    const second = s.batches.list[1];
    if (second) second.ended = true;
    await maintain(s.platform);
    expect(await translationOf(s.platform, en)).toMatchObject({
      status: "translated",
      content: "<p>コードモッドはすべての呼び出しを変える。</p>",
    });
  });

  it("ページの本文が抜けていれば、ページの本文を送り、それで組み立てる", async () => {
    const s = await setup();
    const en = await articleId(s.platform, "en");
    await recordExtractedPageContent(s.platform.db, {
      articleId: en,
      html: "<p>Codemods in the page body.</p>",
      now: new Date(),
    });
    // ページの本文の言語を判定する（訳すかどうかは、ページの判定が済んでから決める）
    await runJob(s.platform, { type: "detect-article-languages" });
    s.batches.transform = (segment) =>
      segment.id === "b1" ? "ページの本文のコードモッド。" : defaultTransform(segment);
    await maintain(s.platform);
    const batch = s.batches.list[0];
    if (batch) batch.ended = true;
    await maintain(s.platform);
    expect(await translationOf(s.platform, en)).toMatchObject({
      status: "translated",
      content: "<p>ページの本文のコードモッド。</p>",
      contentSource: "page",
    });
  });

  it("API キーがない設定では、送らない", async () => {
    const s = await setup({ translator: false });
    await maintain(s.platform);
    expect(s.batches.list).toHaveLength(0);
    expect(s.claude).toHaveLength(0);
  });
});

describe("バッチの失敗を数える（docs/decisions/translation.md の 4、8、9）", () => {
  const sentIds = (batch: FakeBatch | undefined) => batch?.requests.map((r) => r.custom_id) ?? [];
  /** そのバッチを終えて、記事ごとの結果を決める */
  function endBatch(s: Setup, index: number, results: Record<string, unknown>) {
    const batch = s.batches.list[index];
    if (!batch) throw new Error(`no batch ${index}`);
    batch.ended = true;
    batch.results = new Map(Object.entries(results));
  }
  const errored = (type: string) => ({
    type: "errored",
    error: { type: "error", error: { type, message: "failed" } },
  });
  const succeeded = (text: string, stop = "end_turn") => ({
    type: "succeeded",
    message: messageJson("claude-sonnet-5-5", text, stop),
  });

  it("expired の記事は待ちに戻って送り直され、3 回目も expired なら untranslated になる", async () => {
    const s = await setup();
    const en = await articleId(s.platform, "en");
    await maintain(s.platform);
    for (let i = 0; i < 3; i++) {
      endBatch(s, i, { [en]: { type: "expired" } });
      await maintain(s.platform);
      expect((await translationOf(s.platform, en))?.batchAttempts).toBe(i + 1);
    }
    expect(s.batches.list).toHaveLength(3);
    expect(await translationOf(s.platform, en)).toMatchObject({
      status: "untranslated",
      batchKey: null,
    });
    expect(s.notified).toContain(TEST_USER.id);
  });

  it("一時的な errored は何回続いても数えず、待ちに戻る", async () => {
    const s = await setup();
    const en = await articleId(s.platform, "en");
    await maintain(s.platform);
    for (const [i, type] of [
      "overloaded_error",
      "rate_limit_error",
      "api_error",
      "overloaded_error",
    ].entries()) {
      endBatch(s, i, { [en]: errored(type) });
      await maintain(s.platform);
    }
    expect(await translationOf(s.platform, en)).toMatchObject({
      status: "queued",
      batchAttempts: 0,
    });
    expect(s.batches.list).toHaveLength(5);
  });

  it("新しく選んだモデルで errored の invalid_request_error が続けて 3 件起きると、次のバッチから 1 つ前のモデルで送る。回数は数えない", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = await setup({
      extraEnglish: 2,
      models: () =>
        modelsResponse([
          modelInfo("claude-sonnet-6", "2026-09-01T00:00:00Z"),
          modelInfo("claude-sonnet-5-5", "2026-06-01T00:00:00Z"),
        ]),
    });
    await decideTranslations(s.platform.db);
    await maintain(s.platform);
    const first = s.batches.list[0];
    expect(first?.requests.map((r) => r.params.model)).toEqual(Array(3).fill("claude-sonnet-6"));
    endBatch(
      s,
      0,
      Object.fromEntries(
        (first?.requests ?? []).map((r) => [r.custom_id, errored("invalid_request_error")]),
      ),
    );
    await maintain(s.platform);
    expect(s.batches.list[1]?.requests.map((r) => r.params.model)).toEqual(
      Array(3).fill("claude-sonnet-5-5"),
    );
    const attempts = await testDb
      .prepare("SELECT max(batch_attempts) AS n FROM article_translations")
      .first<number>("n");
    expect(attempts).toBe(0);
  });

  it("要求の形の誤りの間に expired が入ると、続けて数えない（モデルを外さない）", async () => {
    const s = await setup({
      models: () =>
        modelsResponse([
          modelInfo("claude-sonnet-6", "2026-09-01T00:00:00Z"),
          modelInfo("claude-sonnet-5-5", "2026-06-01T00:00:00Z"),
        ]),
    });
    const en = await articleId(s.platform, "en");
    await maintain(s.platform);
    const sequence = [
      errored("invalid_request_error"),
      { type: "expired" },
      errored("invalid_request_error"),
      errored("invalid_request_error"),
    ];
    for (const [i, result] of sequence.entries()) {
      endBatch(s, i, { [en]: result });
      await maintain(s.platform);
    }
    expect(s.batches.list[4]?.requests.map((r) => r.params.model)).toEqual(["claude-sonnet-6"]);
  });

  it("バッチを作るときの要求の形の誤りの間にほかの失敗（401）が入ると、続けて数えない（モデルを外さない）", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = await setup({
      models: () =>
        modelsResponse([
          modelInfo("claude-sonnet-6", "2026-09-01T00:00:00Z"),
          modelInfo("claude-sonnet-5-5", "2026-06-01T00:00:00Z"),
        ]),
    });
    const en = await articleId(s.platform, "en");
    const failures = [
      [400, "invalid_request_error"],
      [401, "authentication_error"],
      [400, "invalid_request_error"],
      [400, "invalid_request_error"],
    ] as const;
    for (const [status, type] of failures) {
      s.batches.createFailure = () =>
        Response.json({ type: "error", error: { type, message: "x" } }, { status });
      await maintain(s.platform);
    }
    s.batches.createFailure = null;
    await maintain(s.platform);
    expect(sentIds(s.batches.list[0])).toEqual([en]);
    expect(s.batches.list[0]?.requests.map((r) => r.params.model)).toEqual(["claude-sonnet-6"]);
  });

  it("拒否（refusal）された記事は、その回で untranslated になる", async () => {
    const s = await setup();
    const en = await articleId(s.platform, "en");
    await maintain(s.platform);
    endBatch(s, 0, { [en]: succeeded("", "refusal") });
    await maintain(s.platform);
    expect(await translationOf(s.platform, en)).toMatchObject({ status: "untranslated" });
    expect(s.batches.list).toHaveLength(1);
  });

  it("上限で切れた応答と、読めない応答は、回数に数える", async () => {
    const s = await setup();
    const en = await articleId(s.platform, "en");
    await maintain(s.platform);
    endBatch(s, 0, { [en]: succeeded(translated([]), "max_tokens") });
    await maintain(s.platform);
    expect(await translationOf(s.platform, en)).toMatchObject({
      status: "queued",
      batchAttempts: 1,
    });
    endBatch(s, 1, { [en]: succeeded("not json") });
    await maintain(s.platform);
    expect(await translationOf(s.platform, en)).toMatchObject({
      status: "queued",
      batchAttempts: 2,
    });
  });

  it("もう見られないバッチの記事は、印を外して回数に数える", async () => {
    const s = await setup();
    const en = await articleId(s.platform, "en");
    await maintain(s.platform);
    const batch = s.batches.list[0];
    if (batch) batch.gone = true;
    await maintain(s.platform);
    expect(await translationOf(s.platform, en)).toMatchObject({
      status: "queued",
      batchAttempts: 1,
    });
    expect(sentIds(s.batches.list[1])).toEqual([en]);
  });

  it("結果が返る前にその場の翻訳を始めた記事に expired が返ると、translating のまま始めた時刻も変わらない", async () => {
    const s = await setup();
    const en = await articleId(s.platform, "en");
    await maintain(s.platform);
    await request(s, en);
    const before = await translationOf(s.platform, en);
    endBatch(s, 0, { [en]: { type: "expired" } });
    await maintain(s.platform);
    expect(await translationOf(s.platform, en)).toMatchObject({
      status: "translating",
      startedAt: before?.startedAt,
      batchKey: null,
    });
  });

  it("モデルを外す判断に数えない要求の形の誤り（固定のモデル、一度訳せたモデル）は、回数に数え、3 回目で untranslated になる", async () => {
    const s = await setup({ env: { TRANSLATION_MODEL: "claude-sonnet-4-5" } });
    const en = await articleId(s.platform, "en");
    await maintain(s.platform);
    for (let i = 0; i < 3; i++) {
      endBatch(s, i, { [en]: errored("invalid_request_error") });
      await maintain(s.platform);
    }
    expect(await translationOf(s.platform, en)).toMatchObject({
      status: "untranslated",
      batchAttempts: 3,
    });
  });

  it("一時的でない errored（利用上限、権限など）は回数に数え、3 回目で untranslated になる", async () => {
    const s = await setup();
    const en = await articleId(s.platform, "en");
    await maintain(s.platform);
    for (const [i, type] of [
      "billing_error",
      "permission_error",
      "authentication_error",
    ].entries()) {
      endBatch(s, i, { [en]: errored(type) });
      await maintain(s.platform);
    }
    expect(await translationOf(s.platform, en)).toMatchObject({
      status: "untranslated",
      batchAttempts: 3,
    });
  });

  it("同じバッチで訳せたモデルの要求の形の誤りは、結果の並びによらず、記事の中身によるものとして数える", async () => {
    const s = await setup({
      extraEnglish: 1,
      models: () =>
        modelsResponse([
          modelInfo("claude-sonnet-6", "2026-09-01T00:00:00Z"),
          modelInfo("claude-sonnet-5-5", "2026-06-01T00:00:00Z"),
        ]),
    });
    const en = await articleId(s.platform, "en");
    const other = await articleId(s.platform, "en-0");
    await decideTranslations(s.platform.db);
    await maintain(s.platform);
    // 誤りが先に並んでいても、訳せた結果を先に数える
    const batch = s.batches.list[0];
    if (!batch) throw new Error("no batch");
    batch.ended = true;
    batch.results = new Map([[en, errored("invalid_request_error")]]);
    batch.requests.sort((a) => (a.custom_id === en ? -1 : 1));
    await maintain(s.platform);
    expect(await translationOf(s.platform, other)).toMatchObject({ status: "translated" });
    expect(await translationOf(s.platform, en)).toMatchObject({
      status: "queued",
      batchAttempts: 1,
    });
    // モデルは外さない
    expect(s.batches.list[1]?.requests.map((r) => r.params.model)).toEqual(["claude-sonnet-6"]);
  });

  it("その場の翻訳の最中の記事に拒否が返っても、状態と始めた時刻は変えない", async () => {
    const s = await setup();
    const en = await articleId(s.platform, "en");
    await maintain(s.platform);
    await request(s, en);
    const before = await translationOf(s.platform, en);
    endBatch(s, 0, { [en]: succeeded("", "refusal") });
    await maintain(s.platform);
    expect(await translationOf(s.platform, en)).toMatchObject({
      status: "translating",
      startedAt: before?.startedAt,
      batchKey: null,
    });
  });

  it("バッチを作ろうとして 5xx が返ると（作られたかもしれない）印を残す。529 は断られたものとしてすぐ戻す", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = await setup();
    const en = await articleId(s.platform, "en");
    s.batches.createFailure = () =>
      Response.json({ type: "error", error: { type: "api_error", message: "x" } }, { status: 500 });
    await maintain(s.platform);
    expect((await translationOf(s.platform, en))?.batchKey).not.toBeNull();
    s.batches.createFailure = null;
    await maintain(s.platform);
    expect(s.batches.list).toHaveLength(0);

    await testDb.exec(
      `UPDATE article_translations SET batch_key = NULL, batch_marked_at = NULL WHERE article_id = '${en}'`,
    );
    s.batches.createFailure = () =>
      Response.json(
        { type: "error", error: { type: "overloaded_error", message: "x" } },
        { status: 529 },
      );
    await maintain(s.platform);
    expect(await translationOf(s.platform, en)).toMatchObject({ status: "queued", batchKey: null });
  });

  it("バッチを送ろうとして認証の失敗（401）か利用上限が返ると、待ちのまま回数は変わらず、次の定期実行で送る", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const [status, type] of [
      [401, "authentication_error"],
      [400, "billing_error"],
    ] as const) {
      await testDb.exec("DELETE FROM feeds");
      const s = await setup();
      const en = await articleId(s.platform, "en");
      s.batches.createFailure = () =>
        Response.json({ type: "error", error: { type, message: "x" } }, { status });
      await maintain(s.platform);
      expect(await translationOf(s.platform, en)).toMatchObject({
        status: "queued",
        batchKey: null,
        batchAttempts: 0,
      });
      s.batches.createFailure = null;
      await maintain(s.platform);
      expect(sentIds(s.batches.list[0])).toEqual([en]);
    }
  });
});

describe("Opus で訳し直す（docs/decisions/translation.md の 6、9、13）", () => {
  const sentModels = (s: Setup) =>
    s.claude.map((sent) => (JSON.parse(sent.body) as { model: string }).model);

  it("訳文のある記事を訳し直すと、最中ももとの訳文が残り、最新の Opus の訳文に置き換わって印が付く", async () => {
    const s = await setup({
      body: ARTICLE_BODY,
      models: () =>
        modelsResponse([
          modelInfo("claude-opus-6", "2026-10-01T00:00:00Z"),
          modelInfo("claude-opus-5-5", "2026-07-01T00:00:00Z"),
          modelInfo("claude-sonnet-5-5", "2026-06-01T00:00:00Z"),
        ]),
    });
    const id = await translatedArticle(s);
    const before = await translationOf(s.platform, id);
    expect(before).toMatchObject({
      status: "translated",
      model: "claude-sonnet-5-5",
      retranslated: false,
    });

    const accepted = await retranslate(s, id);
    expect(accepted.response.status).toBe(202);
    expect(accepted.body).toEqual({ status: "translating" });
    expect(s.enqueued).toEqual([
      expect.objectContaining({ type: "translate-article", articleId: id, retranslation: true }),
    ]);
    // 訳し直した訳文が入るまで、もとの訳文を返す
    expect(await translationOf(s.platform, id)).toMatchObject({
      status: "translating",
      title: JA_TITLE,
      translatedAt: before?.translatedAt,
    });
    const during = await requestApp(s.platform, `/api/v1/articles/${id}/translation`);
    expect(during.status).toBe(200);
    expect(await during.json()).toMatchObject({ title: JA_TITLE, model: "claude-sonnet-5-5" });

    s.replies.push(opusReply);
    await runQueuedTranslation(s);
    expect(sentModels(s)).toEqual(["claude-opus-6"]);
    // 本文も送り、訳文を置き換える
    const sent = JSON.parse(s.claude[0]?.body ?? "{}") as { messages: { content: string }[] };
    expect(sent.messages[0]?.content).toContain("Why codemods");
    const after = await translationOf(s.platform, id);
    expect(after).toMatchObject({
      status: "translated",
      title: OPUS_TITLE,
      summary: OPUS_SUMMARY,
      model: "claude-opus-6",
      retranslated: true,
      startedAt: null,
      attempts: 0,
    });
    expect(after?.translatedAt?.getTime()).toBeGreaterThanOrEqual(
      before?.translatedAt?.getTime() ?? Number.POSITIVE_INFINITY,
    );
    expect(after?.content).not.toBeNull();

    // その場の翻訳のモデルは変わらない
    const other = await articleId(s.platform, "und");
    await translateWith(s, other);
    expect(sentModels(s).at(-1)).toBe("claude-sonnet-5-5");
  });

  /** untranslated の記事をその場で訳す（訳し直しのあとも、その場の翻訳は Sonnet で送る） */
  async function translateWith(s: Setup, id: string) {
    s.enqueued.length = 0;
    expect((await request(s, id)).response.status).toBe(202);
    await runQueuedTranslation(s);
  }

  it("RETRANSLATION_MODEL を書くと、そのモデルで訳し直す", async () => {
    const s = await setup({ env: { RETRANSLATION_MODEL: "claude-opus-4-5" } });
    const id = await translatedArticle(s);
    await retranslate(s, id);
    await runQueuedTranslation(s);
    expect(sentModels(s)).toEqual(["claude-opus-4-5"]);
    expect(await translationOf(s.platform, id)).toMatchObject({
      model: "claude-opus-4-5",
      retranslated: true,
    });
  });

  it("訳し直した記事には、送らずに retranslation_not_allowed を返す", async () => {
    const s = await setup();
    const id = await translatedArticle(s);
    await retranslate(s, id);
    await runQueuedTranslation(s);
    s.enqueued.length = 0;
    const sent = s.claude.length;

    const again = await retranslate(s, id);
    expect(again.response.status).toBe(409);
    expect(again.body.error?.code).toBe("retranslation_not_allowed");
    expect(s.enqueued).toEqual([]);
    expect(s.claude).toHaveLength(sent);
    expect(await translationOf(s.platform, id)).toMatchObject({
      status: "translated",
      retranslated: true,
    });
  });

  it("訳文のない記事（queued ／ untranslated ／ translating）には retranslation_not_allowed、訳さない記事と使えない Sendo には、その場の翻訳と同じ答えを返す", async () => {
    const s = await setup();
    await maintain(s.platform);
    const en = await articleId(s.platform, "en");
    const und = await articleId(s.platform, "und");
    const ja = await articleId(s.platform, "ja");
    for (const [id, status] of [
      [en, "queued"],
      [und, "untranslated"],
    ] as const) {
      expect(await translationOf(s.platform, id)).toMatchObject({ status });
      const refused = await retranslate(s, id);
      expect(refused.response.status).toBe(409);
      expect(refused.body.error?.code).toBe("retranslation_not_allowed");
    }
    // その場の翻訳の最中
    await request(s, en);
    expect((await retranslate(s, en)).body.error?.code).toBe("retranslation_not_allowed");
    const skipped = await retranslate(s, ja);
    expect(skipped.response.status).toBe(409);
    expect(skipped.body.error?.code).toBe("translation_not_supported");
    expect(s.enqueued.filter((j) => j.type === "translate-article")).toHaveLength(1);

    await testDb.exec("DELETE FROM feeds");
    const off = await setup({ translator: false });
    const unavailable = await retranslate(off, await articleId(off.platform, "en"));
    expect(unavailable.response.status).toBe(503);
    expect(unavailable.body.error?.code).toBe("translation_unavailable");
  });

  it("2 つの求めが重なっても、受け付けるのは 1 つで、Opus に送るのは 1 回だけ", async () => {
    const s = await setup();
    const id = await translatedArticle(s);
    const results = await Promise.all([retranslate(s, id), retranslate(s, id)]);
    expect(results.map((r) => r.response.status).sort()).toEqual([202, 409]);
    expect(results.find((r) => r.response.status === 409)?.body.error?.code).toBe(
      "retranslation_not_allowed",
    );
    expect(s.enqueued.filter((j) => j.type === "translate-article")).toHaveLength(1);
    await runQueuedTranslation(s);
    expect(s.claude).toHaveLength(1);
  });

  it("やり直しても通らない失敗はその回で、もとの訳文のまま translated に戻り、印は付かない。もう一度求められる", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const reply of [
      { text: "", stop: "refusal" },
      { status: 400, errorType: "invalid_request_error" },
    ] satisfies Reply[]) {
      await testDb.exec("DELETE FROM feeds");
      const s = await setup();
      const id = await translatedArticle(s);
      const before = await translationOf(s.platform, id);
      await retranslate(s, id);
      s.replies.push(reply);
      await runQueuedTranslation(s);
      expect(s.claude).toHaveLength(1);
      expect(await translationOf(s.platform, id)).toMatchObject({
        status: "translated",
        title: JA_TITLE,
        model: "claude-sonnet-5-5",
        translatedAt: before?.translatedAt,
        retranslated: false,
        startedAt: null,
      });

      s.enqueued.length = 0;
      expect((await retranslate(s, id)).response.status).toBe(202);
      s.replies.push(opusReply);
      await runQueuedTranslation(s);
      expect(await translationOf(s.platform, id)).toMatchObject({
        title: OPUS_TITLE,
        retranslated: true,
      });
    }
  });

  it("やり直せる失敗は 3 回目で、もとの訳文のまま translated に戻る", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = await setup();
    const id = await translatedArticle(s);
    await retranslate(s, id);
    const overloaded: Reply = { status: 529, errorType: "overloaded_error" };
    s.replies.push(overloaded, overloaded, overloaded);
    await expect(runQueuedTranslation(s)).rejects.toThrow();
    await expect(runQueuedTranslation(s)).rejects.toThrow();
    expect(await translationOf(s.platform, id)).toMatchObject({
      status: "translating",
      attempts: 2,
      title: JA_TITLE,
    });
    await runQueuedTranslation(s);
    expect(s.claude).toHaveLength(3);
    expect(await translationOf(s.platform, id)).toMatchObject({
      status: "translated",
      title: JA_TITLE,
      retranslated: false,
      startedAt: null,
    });
  });

  it("容量が足りなければ、送らずに（受け取ったあとなら呼び直さずに）もとの訳文のまま translated に戻る", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = await setup();
    const id = await translatedArticle(s);
    await retranslate(s, id);
    const usage = await readStorageUsage(s.platform.db);
    const job = s.enqueued.find((j) => j.type === "translate-article");
    if (!job) throw new Error("no job");
    await runJob({ ...s.platform, retentionConfig: { maxBytes: usage.bytes + 100 } }, job);
    expect(s.claude).toHaveLength(0);
    expect(await translationOf(s.platform, id)).toMatchObject({
      status: "translated",
      title: JA_TITLE,
      retranslated: false,
    });

    s.enqueued.length = 0;
    await retranslate(s, id);
    const next = s.enqueued.find((j) => j.type === "translate-article");
    if (!next) throw new Error("no job");
    // 見積もり（入力の倍）には収まるが、受け取った訳文は収まらない上限にする
    s.replies.push({ text: translated([{ id: "title", text: "訳".repeat(5000) }]) });
    await runJob({ ...s.platform, retentionConfig: { maxBytes: usage.bytes + 2000 } }, next);
    expect(s.claude).toHaveLength(1);
    expect(await translationOf(s.platform, id)).toMatchObject({
      status: "translated",
      title: JA_TITLE,
      retranslated: false,
    });
  });

  it("仕事を積めなければ、もとの訳文のまま translated に戻す", async () => {
    const s = await setup();
    const id = await translatedArticle(s);
    const platform: Platform = {
      ...s.platform,
      jobs: {
        async enqueue() {
          throw new Error("queue is busy");
        },
      },
    };
    expect((await retranslate(s, id, platform)).response.status).toBe(500);
    expect(await translationOf(s.platform, id)).toMatchObject({
      status: "translated",
      title: JA_TITLE,
      startedAt: null,
      retranslated: false,
    });
  });

  it("始めてから 1 時間を過ぎた訳し直しは、もとの訳文のまま translated に戻し、古い仕事は呼ばない", async () => {
    const s = await setup();
    const id = await translatedArticle(s);
    await retranslate(s, id);
    await s.platform.db
      .update(articleTranslations)
      .set({ startedAt: new Date(Date.now() - 60 * 60 * 1000 - 1000) })
      .where(eq(articleTranslations.articleId, id))
      .run();
    await maintain(s.platform);
    expect(await translationOf(s.platform, id)).toMatchObject({
      status: "translated",
      title: JA_TITLE,
      retranslated: false,
      startedAt: null,
    });
    await runQueuedTranslation(s);
    expect(s.claude).toHaveLength(0);
  });

  it("バッチに送ったあとでその場で訳した記事を訳し直す最中に、そのバッチの結果が返っても、訳文を上書きしない", async () => {
    const s = await setup();
    // 決めた定期実行がバッチで送ったあとで、その場で訳した記事（その場の翻訳がバッチの印を外している）
    const id = await translatedArticle(s);
    expect(s.batches.list).toHaveLength(1);
    expect(s.batches.list[0]?.requests.map((r) => r.custom_id)).toContain(id);
    await retranslate(s, id);

    const batch = s.batches.list[0];
    if (batch) batch.ended = true;
    s.batches.transform = (segment) => (segment.id === "title" ? "バッチの訳" : undefined);
    await maintain(s.platform);
    expect(await translationOf(s.platform, id)).toMatchObject({
      status: "translating",
      title: JA_TITLE,
    });

    s.replies.push(opusReply);
    await runQueuedTranslation(s);
    expect(await translationOf(s.platform, id)).toMatchObject({
      status: "translated",
      title: OPUS_TITLE,
      retranslated: true,
    });
  });

  it("バッチで訳した記事を訳し直す", async () => {
    const s = await setup();
    await maintain(s.platform);
    const id = await articleId(s.platform, "en");
    const batch = s.batches.list[0];
    if (!batch) throw new Error("no batch");
    batch.ended = true;
    await maintain(s.platform);
    expect(await translationOf(s.platform, id)).toMatchObject({
      status: "translated",
      title: JA_TITLE,
      retranslated: false,
    });

    expect((await retranslate(s, id)).response.status).toBe(202);
    s.replies.push(opusReply);
    await runQueuedTranslation(s);
    expect(sentModels(s)).toEqual(["claude-opus-5-5"]);
    expect(await translationOf(s.platform, id)).toMatchObject({
      status: "translated",
      title: OPUS_TITLE,
      model: "claude-opus-5-5",
      retranslated: true,
    });
  });

  const DAY = 24 * 60 * 60 * 1000;

  it("その場の翻訳と訳し直しは同じ一覧を使い、1 日ごとの取り直しも 1 度だけで、両方に効く", async () => {
    let list = [
      modelInfo("claude-sonnet-6", "2026-09-01T00:00:00Z"),
      modelInfo("claude-opus-6", "2026-10-01T00:00:00Z"),
    ];
    const s = await setup({ models: () => modelsResponse(list) });
    const en = await translatedArticle(s);
    await retranslate(s, en);
    await runQueuedTranslation(s);
    expect(s.models.requests).toBe(1);

    list = [
      ...list,
      modelInfo("claude-sonnet-7", "2026-11-01T00:00:00Z"),
      modelInfo("claude-opus-7", "2026-11-02T00:00:00Z"),
    ];
    s.clock.ms += DAY;
    const und = await articleId(s.platform, "und");
    s.enqueued.length = 0;
    await request(s, und);
    await runQueuedTranslation(s);
    s.enqueued.length = 0;
    await retranslate(s, und);
    await runQueuedTranslation(s);
    expect(s.models.requests).toBe(2);
    expect(sentModels(s)).toEqual(["claude-opus-6", "claude-sonnet-7", "claude-opus-7"]);
  });

  it("一覧を取れなければ、訳し直しはコードの既定の Opus（前に取れていれば、前に選んだもの）で送る", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = await setup({
      models: () =>
        Response.json(
          { type: "error", error: { type: "api_error", message: "x" } },
          { status: 500 },
        ),
    });
    const id = await translatedArticle(s);
    await retranslate(s, id);
    await runQueuedTranslation(s);
    expect(sentModels(s)).toEqual([DEFAULT_FAMILY_MODELS.opus]);

    await testDb.exec("DELETE FROM feeds");
    const t = await setup({
      models: () => modelsResponse([modelInfo("claude-opus-6", "2026-10-01T00:00:00Z")]),
    });
    const other = await translatedArticle(t);
    t.models.reply = () =>
      Response.json({ type: "error", error: { type: "api_error", message: "x" } }, { status: 500 });
    t.clock.ms += DAY;
    await retranslate(t, other);
    await runQueuedTranslation(t);
    expect(t.models.requests).toBe(2);
    expect(sentModels(t)).toEqual(["claude-opus-6"]);
  });

  it("新しい Opus で要求の形の誤りが続けて 3 件起きたら Opus だけを外し、その場の翻訳のモデルは変わらない", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = await setup({
      models: () =>
        modelsResponse([
          modelInfo("claude-opus-6", "2026-10-01T00:00:00Z"),
          modelInfo("claude-opus-5-5", "2026-07-01T00:00:00Z"),
          modelInfo("claude-sonnet-6", "2026-09-01T00:00:00Z"),
          modelInfo("claude-sonnet-5-5", "2026-06-01T00:00:00Z"),
        ]),
    });
    const id = await translatedArticle(s);
    const invalid: Reply = { status: 400, errorType: "invalid_request_error" };
    for (let i = 0; i < 3; i++) {
      s.enqueued.length = 0;
      expect((await retranslate(s, id)).response.status).toBe(202);
      s.replies.push(invalid);
      await runQueuedTranslation(s);
    }
    s.enqueued.length = 0;
    await retranslate(s, id);
    await runQueuedTranslation(s);
    const und = await articleId(s.platform, "und");
    s.enqueued.length = 0;
    await request(s, und);
    await runQueuedTranslation(s);
    expect(sentModels(s)).toEqual([
      "claude-opus-6",
      "claude-opus-6",
      "claude-opus-6",
      "claude-opus-5-5",
      "claude-sonnet-6",
    ]);
  });

  it("本文の指定は省いても、retranslate が false でも、その場の翻訳になる。読めない本文は 400、受け付けない Content-Type は 415 で、状態を変えない", async () => {
    const s = await setup();
    await maintain(s.platform);
    const en = await articleId(s.platform, "en");
    const und = await articleId(s.platform, "und");
    const post = (id: string, init: RequestInit & { json?: unknown }) =>
      requestApp(s.platform, `/api/v1/articles/${id}/translation`, { method: "POST", ...init });

    const malformed = await post(en, { headers: { "content-type": "application/json" } });
    expect(malformed.status).toBe(400);
    expect(((await malformed.json()) as Body).error?.code).toBe("invalid_request");
    const unsupported = await post(en, { headers: { "content-type": "text/plain" }, body: "x" });
    expect(unsupported.status).toBe(415);
    expect(((await unsupported.json()) as Body).error?.code).toBe("unsupported_media_type");
    expect(await translationOf(s.platform, en)).toMatchObject({ status: "queued" });

    expect((await post(en, { json: {} })).status).toBe(202);
    expect((await post(und, { json: { retranslate: false } })).status).toBe(202);
    expect(s.enqueued.filter((j) => j.type === "translate-article")).toEqual([
      expect.not.objectContaining({ retranslation: true }),
      expect.not.objectContaining({ retranslation: true }),
    ]);
  });

  it("もとの訳文に本文があれば、あとでページの本文が抜けても、同じ出どころ（フィード）の本文を訳し直す", async () => {
    const s = await setup({ body: ARTICLE_BODY });
    const id = await translatedArticle(s);
    expect(await translationOf(s.platform, id)).toMatchObject({ contentSource: "feed" });
    // 訳したあとで抜けた、上限（60,000 文字）を超えるページの本文
    await recordExtractedPageContent(s.platform.db, {
      articleId: id,
      html: `<p>${"Long page body. ".repeat(4000)}</p>`,
      now: new Date(),
    });
    await retranslate(s, id);
    s.replies.push({ transform: (segment) => `訳:${segment.text}` });
    await runQueuedTranslation(s);
    const sent = JSON.parse(s.claude[0]?.body ?? "{}") as { messages: { content: string }[] };
    expect(sent.messages[0]?.content).toContain("Why codemods");
    expect(sent.messages[0]?.content).not.toContain("Long page body");
    const row = await translationOf(s.platform, id);
    expect(row).toMatchObject({ status: "translated", contentSource: "feed", retranslated: true });
    expect(row?.content).toContain("訳:Why codemods");
  });

  it("もとの訳文に本文があるのに、同じ出どころの本文を置けなければ、呼ばずにもとの訳文のまま戻す", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = await setup();
    await maintain(s.platform);
    const id = await articleId(s.platform, "en");
    await recordExtractedPageContent(s.platform.db, {
      articleId: id,
      html: "<p>Page body about codemods.</p>",
      now: new Date(),
    });
    await request(s, id);
    await runQueuedTranslation(s);
    s.enqueued.length = 0;
    s.claude.length = 0;
    const before = await translationOf(s.platform, id);
    expect(before).toMatchObject({ contentSource: "page" });
    expect(before?.content).not.toBeNull();
    // ページの本文がなくなった（本番では片付けなどで起きうるが、作りにくいので直接消す）
    await testDb.exec(`DELETE FROM page_contents WHERE article_id = '${id}'`);

    await retranslate(s, id);
    await runQueuedTranslation(s);
    expect(s.claude).toHaveLength(0);
    expect(await translationOf(s.platform, id)).toMatchObject({
      status: "translated",
      title: JA_TITLE,
      content: before?.content,
      contentSource: "page",
      retranslated: false,
      startedAt: null,
    });
  });

  it("訳し直した本文を組み立てて 256KB を超えたら、呼び直さずに、もとの訳文のまま戻す", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = await setup({ body: ARTICLE_BODY });
    const id = await translatedArticle(s);
    const before = await translationOf(s.platform, id);
    expect(before?.content).not.toBeNull();
    await retranslate(s, id);
    s.replies.push({
      transform: (segment) =>
        segment.id === "title" || segment.id === "summary" ? OPUS_TITLE : "訳".repeat(30_000),
    });
    // やり直しのために例外を投げない（呼び直さない）
    await runQueuedTranslation(s);
    expect(s.claude).toHaveLength(1);
    expect(await translationOf(s.platform, id)).toMatchObject({
      status: "translated",
      title: JA_TITLE,
      content: before?.content,
      model: "claude-sonnet-5-5",
      retranslated: false,
      startedAt: null,
    });
  });

  it("もとの訳文に本文がなければ、本文を置けなくても、タイトルと要約だけを訳し直す", async () => {
    const s = await setup();
    const id = await translatedArticle(s);
    expect(await translationOf(s.platform, id)).toMatchObject({ content: null });
    await retranslate(s, id);
    s.replies.push(opusReply);
    await runQueuedTranslation(s);
    expect(await translationOf(s.platform, id)).toMatchObject({
      status: "translated",
      title: OPUS_TITLE,
      content: null,
      retranslated: true,
    });
  });
});

describe("同じ元記事の訳を写す（docs/decisions/translation.md の 16）", () => {
  /** 実例：Hacker News: Best と Lobsters が、同じ GnuPG の勧告を違うタイトル・要約で配る */
  const GPGME_URL = "https://lists.gnupg.org/pipermail/gnupg-announce/2026q4/000517.html";
  const GPGME_PAGE =
    "<p>GnuPG Security Advisory: a bug in GPGME allows a crafted message to crash the client.</p><p>Update GPGME to version 2.0.1.</p>";
  const item = (guid: string, title: string, link: string, description?: string) =>
    `<item><title>${title}</title><link>${link}</link><guid>${guid}</guid>${
      description === undefined ? "" : `<description>${description}</description>`
    }</item>`;
  const channel = (title: string, items: string) =>
    `<?xml version="1.0"?><rss version="2.0"><channel><title>${title}</title><link>https://${FEED_HOST}/</link>${items}</channel></rss>`;
  const hn = () =>
    channel(
      "Hacker News: Best",
      item(
        "hn-1",
        "GnuPG Security Advisory for GPGME",
        GPGME_URL,
        `Article URL: ${GPGME_URL} Comments URL: https://news.ycombinator.com/item?id=1 Points: 262 # Comments: 113`,
      ),
    );
  const lobsters = () =>
    channel(
      "Lobsters",
      item(
        "lobsters-1",
        "GnuPG Security Advisory for GPGME (T8557,CVE-2026-129975)",
        GPGME_URL,
        "Comments",
      ),
    );
  /** 要約のない、URL の表記の違う同じ元記事 */
  const mirror = () =>
    channel(
      "Mirror",
      item(
        "mirror-1",
        "GnuPG Security Advisory for GPGME",
        "http://Lists.GnuPG.org/pipermail/gnupg-announce/2026q4/000517.html/?utm_source=feed#top",
      ),
    );
  /** サイトの最初のページを指す記事（使い回さない） */
  const topPage = () =>
    channel("Top", item("top-1", "GnuPG Security Advisory for GPGME", "https://lists.gnupg.org/"));

  /** HN と同じ要約の、同じ元記事（すべて写せる） */
  const hnCopy = () =>
    channel(
      "Hacker News: Front Page",
      item(
        "hn-copy-1",
        "GnuPG Security Advisory for GPGME",
        GPGME_URL,
        `Article URL: ${GPGME_URL} Comments URL: https://news.ycombinator.com/item?id=1 Points: 262 # Comments: 113`,
      ),
    );

  /** 要約のない、URL の表記の違う、もう 1 つの同じ元記事 */
  const mirror2 = () =>
    channel(
      "Mirror 2",
      item(
        "mirror2-1",
        "GnuPG Security Advisory for GPGME",
        "https://lists.gnupg.org/pipermail/gnupg-announce/2026q4/000517.html?utm_medium=rss",
      ),
    );
  /** タイトルのない、同じ元記事 */
  const untitled = () =>
    channel("Untitled", `<item><link>${GPGME_URL}</link><guid>untitled-1</guid></item>`);

  const feeds = {
    "/hn.xml": hn,
    "/lobsters.xml": lobsters,
    "/mirror.xml": mirror,
    "/top.xml": topPage,
    "/hn-copy.xml": hnCopy,
    "/untitled.xml": untitled,
    "/mirror2.xml": mirror2,
  };
  /** 訳したことの分かる訳し方 */
  const mark: Transform = (segment) => `訳:${segment.text}`;

  /** フィードを取得し、ページの本文を抜けたことにして、言語を判定する。記事の ID を返す */
  async function deliver(s: Setup, path: string, page: string | null = GPGME_PAGE) {
    const feedId = s.feedIds[path];
    if (feedId === undefined) throw new Error(`no feed ${path}`);
    await runFetchFeed(s.platform, feedId);
    for (const job of s.enqueued.splice(0)) {
      if (job.type === "extract-page") await runJob(s.platform, job);
    }
    const row = await s.platform.db
      .select({ id: articles.id })
      .from(articles)
      .where(eq(articles.feedId, feedId))
      .get();
    if (!row) throw new Error(`no article in ${path}`);
    // ページの本文が抜けた記事（抜き取りは Rust の処理で、テストの偽のページでは作りにくい）
    if (page !== null) {
      await recordExtractedPageContent(s.platform.db, {
        articleId: row.id,
        html: page,
        now: new Date(),
      });
    }
    await runJob(s.platform, { type: "detect-article-languages" });
    for (let job = s.enqueued.find((j) => j.type === "detect-article-languages"); job; ) {
      s.enqueued.splice(s.enqueued.indexOf(job), 1);
      await runJob(s.platform, job);
      job = s.enqueued.find((j) => j.type === "detect-article-languages");
    }
    s.enqueued.length = 0;
    return row.id;
  }

  /** 送ったバッチの、記事の断片の ID */
  const sentSegments = (batch: FakeBatch | undefined, id: string) => {
    const request = batch?.requests.find((r) => r.custom_id === id);
    const content = (request?.params.messages as { content: string }[] | undefined)?.[0]?.content;
    return (JSON.parse(content ?? "{}") as { segments?: { id: string }[] }).segments?.map(
      (segment) => segment.id,
    );
  };

  /** 先の記事（HN）を、バッチで訳し終える */
  async function translatedFirst(s: Setup) {
    const first = await deliver(s, "/hn.xml");
    await maintain(s.platform);
    const batch = s.batches.list.find((b) => b.requests.some((r) => r.custom_id === first));
    if (!batch) throw new Error("the first article was not sent");
    batch.ended = true;
    await maintain(s.platform);
    expect(await translationOf(s.platform, first)).toMatchObject({ status: "translated" });
    return first;
  }

  async function translationApi(s: Setup, id: string) {
    const response = await requestApp(s.platform, `/api/v1/articles/${id}/translation`);
    expect(response.status).toBe(200);
    return (await response.json()) as { title: string | null; content: string | null };
  }

  it("訳し終えた同じ元記事があると、後の記事のバッチには要約だけを送り、タイトルと本文を写す", async () => {
    const s = await setup({ feeds });
    s.batches.transform = mark;
    const first = await translatedFirst(s);
    const firstRow = await translationOf(s.platform, first);
    expect(firstRow?.urlKey).toBe(GPGME_URL);
    expect(firstRow?.bodyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(firstRow?.content).toContain("訳:");

    const second = await deliver(s, "/lobsters.xml");
    const batches = s.batches.list.length;
    await maintain(s.platform);
    const batch = s.batches.list[batches];
    expect(sentSegments(batch, second)).toEqual(["summary"]);
    if (batch) batch.ended = true;
    s.notified.length = 0;
    await maintain(s.platform);

    const secondRow = await translationOf(s.platform, second);
    expect(secondRow).toMatchObject({
      status: "translated",
      title: firstRow?.title,
      summary: "訳:Comments",
      content: firstRow?.content,
      contentSource: "page",
      bodyHash: firstRow?.bodyHash,
      urlKey: GPGME_URL,
      retranslated: false,
    });
    expect((await translationApi(s, second)).content).toBe(
      (await translationApi(s, first)).content,
    );
    // 写した記事も、受信箱に持つ人に知らせる
    expect(s.notified).toContain(TEST_USER.id);

    // 先の記事が消えても、残った記事の訳文は読める
    await s.platform.db.delete(articles).where(eq(articles.id, first)).run();
    expect((await translationApi(s, second)).content).toBe(secondRow?.content);
  });

  it("本文を写す記事は、写す本文を数えずに段階を決める（閾値が 1 文字でも通常の段階で送る）", async () => {
    const s = await setup({ feeds, env: { TRANSLATION_LONG_THRESHOLD_CHARS: "1" } });
    s.batches.transform = mark;
    const first = await translatedFirst(s);
    // 先の記事は本文を送ったので長文
    const firstSent = s.batches.list.flatMap((b) => b.requests).find((r) => r.custom_id === first);
    expect(firstSent?.params).toMatchObject({
      model: "claude-haiku-5-5",
      output_config: { effort: "low" },
    });

    const second = await deliver(s, "/lobsters.xml");
    const batches = s.batches.list.length;
    await maintain(s.platform);
    const batch = s.batches.list[batches];
    expect(sentSegments(batch, second)).toEqual(["summary"]);
    expect(batch?.requests.find((r) => r.custom_id === second)?.params).toMatchObject({
      model: "claude-sonnet-5-5",
      output_config: { effort: "medium" },
    });
  });

  it("すべて写せる記事は、バッチに送らずに translated になる（URL の表記が違っても同じ元記事）。空のバッチを作らない", async () => {
    const s = await setup({ feeds });
    s.batches.transform = mark;
    const first = await translatedFirst(s);
    const firstRow = await translationOf(s.platform, first);
    const third = await deliver(s, "/mirror.xml");
    const batches = s.batches.list.length;
    s.notified.length = 0;
    await maintain(s.platform);
    expect(s.batches.list).toHaveLength(batches);
    expect(await translationOf(s.platform, third)).toMatchObject({
      status: "translated",
      title: firstRow?.title,
      summary: null,
      content: firstRow?.content,
      model: firstRow?.model,
      urlKey: GPGME_URL,
      batchKey: null,
      batchCopies: 0,
    });
    expect(s.notified).toContain(TEST_USER.id);
  });

  it("サイトの最初のページを指す記事は使い回さず、すべて送る", async () => {
    const s = await setup({ feeds });
    s.batches.transform = mark;
    await translatedFirst(s);
    const top = await deliver(s, "/top.xml");
    const batches = s.batches.list.length;
    await maintain(s.platform);
    expect(sentSegments(s.batches.list[batches], top)).toEqual(
      expect.arrayContaining(["title", "b1"]),
    );
    expect((await translationOf(s.platform, top))?.urlKey).toBeNull();
  });

  it("結果を書くときに写す元の記事が消えていたら、タイトルは原文、本文は置かずに書く", async () => {
    const s = await setup({ feeds });
    s.batches.transform = mark;
    const first = await translatedFirst(s);
    const second = await deliver(s, "/lobsters.xml");
    const batches = s.batches.list.length;
    await maintain(s.platform);
    await s.platform.db.delete(articles).where(eq(articles.id, first)).run();
    const batch = s.batches.list[batches];
    if (batch) batch.ended = true;
    await maintain(s.platform);
    expect(await translationOf(s.platform, second)).toMatchObject({
      status: "translated",
      title: "GnuPG Security Advisory for GPGME (T8557,CVE-2026-129975)",
      summary: "訳:Comments",
      content: null,
      contentSource: null,
    });

    // 原文を書いた行は、訳していないので、あとの記事の写す元にしない（タイトルを送る）
    const third = await deliver(s, "/mirror.xml");
    const next = s.batches.list.length;
    await maintain(s.platform);
    expect(sentSegments(s.batches.list[next], third)).toEqual(expect.arrayContaining(["title"]));
  });

  it("すべて写せる記事で、写す文の直前に写す元が消えたら、書かずに待ちに戻す", async () => {
    const s = await setup({ feeds });
    s.batches.transform = mark;
    const first = await translatedFirst(s);
    const third = await deliver(s, "/mirror.xml");
    const hook = statementHook(
      /update article_translations set status = 'translated'/,
      async () => {
        await testDb.exec(`DELETE FROM articles WHERE id = '${first}'`);
      },
    );
    await maintain({ ...s.platform, db: hook.db });
    expect(hook.fired()).toBe(true);
    expect(await translationOf(s.platform, third)).toMatchObject({
      status: "queued",
      title: null,
      batchKey: null,
    });
    // 次の定期実行で、写す元がないのですべて送る
    const batches = s.batches.list.length;
    await maintain(s.platform);
    expect(sentSegments(s.batches.list[batches], third)).toEqual(
      expect.arrayContaining(["title", "b1"]),
    );
  });

  it("その場の翻訳で訳した記事も、指紋を書き、あとの記事の写す元になる", async () => {
    const s = await setup({ feeds });
    const first = await deliver(s, "/hn.xml");
    await maintain(s.platform);
    // バッチを待たずに、その場で訳す（バッチの結果は捨てられる）
    s.enqueued.length = 0;
    expect((await request(s, first)).response.status).toBe(202);
    s.replies.push({ transform: mark });
    await runQueuedTranslation(s);
    const firstRow = await translationOf(s.platform, first);
    expect(firstRow?.bodyHash).toMatch(/^[0-9a-f]{64}$/);

    const third = await deliver(s, "/mirror.xml");
    await maintain(s.platform);
    expect(await translationOf(s.platform, third)).toMatchObject({
      status: "translated",
      title: firstRow?.title,
      content: firstRow?.content,
    });
  });

  it("原文の要約が同じ記事は、要約も写す", async () => {
    const s = await setup({ feeds });
    s.batches.transform = mark;
    const first = await translatedFirst(s);
    const firstRow = await translationOf(s.platform, first);
    const copy = await deliver(s, "/hn-copy.xml");
    const batches = s.batches.list.length;
    await maintain(s.platform);
    expect(s.batches.list).toHaveLength(batches);
    expect(await translationOf(s.platform, copy)).toMatchObject({
      status: "translated",
      title: firstRow?.title,
      summary: firstRow?.summary,
      content: firstRow?.content,
    });
  });

  it("訳し直した行を、新しく訳した行より先に写す元に選び、本文を写したら訳し直しの印も付く", async () => {
    const s = await setup({ feeds });
    s.batches.transform = mark;
    const first = await translatedFirst(s);
    s.enqueued.length = 0;
    expect((await retranslate(s, first)).response.status).toBe(202);
    s.replies.push({ transform: (segment) => `Opus:${segment.text}` });
    await runQueuedTranslation(s);
    const opusRow = await translationOf(s.platform, first);
    expect(opusRow).toMatchObject({ retranslated: true, model: "claude-opus-5-5" });

    // 訳し直した行より新しく訳した、訳し直していない同じ元記事の行（作りにくいので、直接書く）。
    // 本文の指紋が同じだと訳し直しが写るので（下の「訳し直しを広げる」）、違う指紋にする
    const second = await deliver(s, "/lobsters.xml");
    await decideTranslations(s.platform.db);
    expect((await translationOf(s.platform, second))?.urlKey).toBe(GPGME_URL);
    await testDb.exec(`UPDATE article_translations SET status = 'translated',
      title = 'Sonnet の新しい訳', content = '<p>Sonnet の新しい本文</p>', model = 'claude-sonnet-5-5',
      body_hash = 'other', retranslated = 0,
      translated_at = ${(opusRow?.translatedAt?.getTime() ?? 0) + 60_000}
      WHERE article_id = '${second}'`);

    const third = await deliver(s, "/mirror.xml");
    await maintain(s.platform);
    expect(await translationOf(s.platform, third)).toMatchObject({
      status: "translated",
      title: opusRow?.title,
      content: opusRow?.content,
      model: "claude-opus-5-5",
      retranslated: true,
    });
  });

  it("容量の上限に当たったら、すべて写せる行は待ちに戻し、送った行は印を残して、次の定期実行で写す", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = await setup({ feeds });
    s.batches.transform = mark;
    const first = await translatedFirst(s);
    const firstRow = await translationOf(s.platform, first);
    const second = await deliver(s, "/lobsters.xml");
    await maintain(s.platform);
    const third = await deliver(s, "/mirror.xml");
    const batch = s.batches.list.at(-1);
    if (batch) batch.ended = true;

    const usage = await readStorageUsage(s.platform.db);
    const tight = { ...s.platform, retentionConfig: { maxBytes: usage.bytes + 100 } };
    await maintain(tight);
    expect(await translationOf(s.platform, third)).toMatchObject({
      status: "queued",
      title: null,
      batchKey: null,
    });
    expect(await translationOf(s.platform, second)).toMatchObject({
      status: "queued",
      title: null,
      batchId: batch?.id,
      // タイトルと本文を写す部分は、印と一緒に残る（1 + 4）
      batchCopies: 5,
    });

    await maintain(s.platform);
    for (const id of [second, third]) {
      expect(await translationOf(s.platform, id)).toMatchObject({
        status: "translated",
        title: firstRow?.title,
        content: firstRow?.content,
      });
    }
  });

  it("本文の指紋が違う同じ元記事は、本文を送る", async () => {
    const s = await setup({ feeds });
    s.batches.transform = mark;
    await translatedFirst(s);
    const second = await deliver(
      s,
      "/lobsters.xml",
      "<p>GnuPG Security Advisory, updated: a bug in GPGME allows a crafted message to crash.</p>",
    );
    const batches = s.batches.list.length;
    await maintain(s.platform);
    expect(sentSegments(s.batches.list[batches], second)).toEqual(["summary", "b1"]);
  });

  /** その記事を含むバッチ */
  const batchOf = (s: Setup, id: string) =>
    s.batches.list.filter((b) => b.requests.some((r) => r.custom_id === id));

  it("先の記事がバッチの中にある間は後の記事を送らず、先の結果を書いた定期実行で要約だけを送る", async () => {
    const s = await setup({ feeds });
    s.batches.transform = mark;
    const first = await deliver(s, "/hn.xml");
    await maintain(s.platform);
    const [firstBatch] = batchOf(s, first);
    expect(firstBatch).toBeDefined();

    const second = await deliver(s, "/lobsters.xml");
    await maintain(s.platform);
    await maintain(s.platform);
    expect(batchOf(s, second)).toEqual([]);
    expect(await translationOf(s.platform, second)).toMatchObject({
      status: "queued",
      batchKey: null,
    });

    if (firstBatch) firstBatch.ended = true;
    await maintain(s.platform);
    const [secondBatch] = batchOf(s, second);
    expect(sentSegments(secondBatch, second)).toEqual(["summary"]);
    // 本文を送ったのは 1 回だけ
    const bodies = s.batches.list.flatMap((b) =>
      b.requests.filter((r) => (sentSegments(b, r.custom_id) ?? []).includes("b1")),
    );
    expect(bodies).toHaveLength(1);
  });

  it("同じ定期実行で送られうる同じ元記事の記事は、1 つだけを送る", async () => {
    const s = await setup({ feeds });
    const first = await deliver(s, "/hn.xml");
    const second = await deliver(s, "/lobsters.xml");
    await maintain(s.platform);
    const sent = [first, second].filter((id) => batchOf(s, id).length > 0);
    expect(sent).toHaveLength(1);
  });

  it("先の記事が訳せずに印が外れると、次の定期実行では待っていた記事を送る", async () => {
    const s = await setup({ feeds });
    const first = await deliver(s, "/hn.xml");
    await maintain(s.platform);
    const second = await deliver(s, "/lobsters.xml");
    await maintain(s.platform);
    const [firstBatch] = batchOf(s, first);
    if (firstBatch) {
      firstBatch.ended = true;
      firstBatch.results = new Map([[first, { type: "expired" }]]);
    }
    await maintain(s.platform);
    expect(await translationOf(s.platform, first)).toMatchObject({
      status: "queued",
      batchAttempts: 1,
    });
    // 結果を書いた同じ定期実行で、待っていた記事を送り、訳せなかった記事は送らない
    expect(batchOf(s, second)).toHaveLength(1);
    expect(batchOf(s, first)).toHaveLength(1);
  });

  it("すべて写せる記事も、同じ元記事の行がバッチの中にある間は待つ", async () => {
    const s = await setup({ feeds });
    s.batches.transform = mark;
    const first = await translatedFirst(s);
    const firstRow = await translationOf(s.platform, first);
    const second = await deliver(s, "/lobsters.xml");
    await maintain(s.platform);
    const [secondBatch] = batchOf(s, second);
    expect(secondBatch).toBeDefined();

    const third = await deliver(s, "/mirror.xml");
    await maintain(s.platform);
    expect(await translationOf(s.platform, third)).toMatchObject({
      status: "queued",
      batchKey: null,
    });

    if (secondBatch) secondBatch.ended = true;
    await maintain(s.platform);
    expect(await translationOf(s.platform, third)).toMatchObject({
      status: "translated",
      title: firstRow?.title,
      content: firstRow?.content,
    });
  });

  it("同じ元記事の行がその場の翻訳の最中（バッチの印がない）でも、バッチは待たない", async () => {
    const s = await setup({ feeds });
    const first = await deliver(s, "/hn.xml");
    await decideTranslations(s.platform.db);
    expect((await request(s, first)).response.status).toBe(202);
    const second = await deliver(s, "/lobsters.xml");
    await maintain(s.platform);
    expect(batchOf(s, second)).toHaveLength(1);
    expect(batchOf(s, first)).toEqual([]);
  });

  it("2 つの定期実行が重なっても、同じ元記事の行を 2 つ送らない", async () => {
    const s = await setup({ feeds });
    const first = await deliver(s, "/hn.xml");
    const second = await deliver(s, "/lobsters.xml");
    await decideTranslations(s.platform.db);
    // 送る行を取る文の直前に、ほかの定期実行が先に印を付ける
    const hook = statementHook(/update article_translations set batch_key/, async () => {
      await markForBatch(s.platform.db, "other-run");
    });
    await maintain({ ...s.platform, db: hook.db });
    expect(hook.fired()).toBe(true);
    const marked = await testDb
      .prepare(
        `SELECT count(*) AS n FROM article_translations WHERE batch_key IS NOT NULL AND article_id IN ('${first}', '${second}')`,
      )
      .first<number>("n");
    expect(marked).toBe(1);
  });

  it("バッチを作れたか分からずに印が残る間も待ち、印が 1 時間で外れたら、次の定期実行で 1 つだけ送る", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = await setup({ feeds });
    const first = await deliver(s, "/hn.xml");
    const second = await deliver(s, "/lobsters.xml");
    s.batches.createFailure = () =>
      Response.json({ type: "error", error: { type: "api_error", message: "x" } }, { status: 500 });
    await maintain(s.platform);
    const rows = await Promise.all([first, second].map((id) => translationOf(s.platform, id)));
    expect(rows.filter((row) => row?.batchKey != null)).toHaveLength(1);

    // 印が残っている間は、同じ元記事のもう一方も送らない
    s.batches.createFailure = null;
    await maintain(s.platform);
    expect(batchOf(s, first)).toEqual([]);
    expect(batchOf(s, second)).toEqual([]);

    await testDb.exec(
      `UPDATE article_translations SET batch_marked_at = batch_marked_at - ${BATCH_MARK_TTL_MS}`,
    );
    await maintain(s.platform);
    expect(batchOf(s, first).length + batchOf(s, second).length).toBe(1);
  });

  /** その場の翻訳で送った断片の ID（Messages API の要求の中の JSON） */
  const claudeSegments = (s: Setup) =>
    s.claude.map((sent) => {
      const body = JSON.parse(sent.body) as { messages: { content: string }[] };
      return (
        JSON.parse(body.messages[0]?.content ?? "{}") as { segments: { id: string }[] }
      ).segments.map((segment) => segment.id);
    });

  /** 決めて（行を作り）、その場の翻訳を求める。仕事はまだ動かさない */
  async function requestOnDemand(s: Setup, path: string) {
    const id = await deliver(s, path);
    await decideTranslations(s.platform.db);
    s.enqueued.length = 0;
    expect((await request(s, id)).response.status).toBe(202);
    return id;
  }

  it("その場の翻訳では、写せるタイトルと本文を呼ばずに写し、要約だけを Messages API に送る", async () => {
    const s = await setup({ feeds });
    s.batches.transform = mark;
    const first = await translatedFirst(s);
    const firstRow = await translationOf(s.platform, first);
    const second = await requestOnDemand(s, "/lobsters.xml");
    s.replies.push({ transform: mark });
    await runQueuedTranslation(s);
    expect(claudeSegments(s)).toEqual([["summary"]]);
    expect(await translationOf(s.platform, second)).toMatchObject({
      status: "translated",
      title: firstRow?.title,
      summary: "訳:Comments",
      content: firstRow?.content,
      contentSource: "page",
    });
  });

  it("その場の翻訳で、すべて写せる記事は Messages API を呼ばずに translated になり、知らせる", async () => {
    const s = await setup({ feeds });
    s.batches.transform = mark;
    const first = await translatedFirst(s);
    const firstRow = await translationOf(s.platform, first);
    const third = await requestOnDemand(s, "/mirror.xml");
    s.notified.length = 0;
    await runQueuedTranslation(s);
    expect(s.claude).toHaveLength(0);
    expect(await translationOf(s.platform, third)).toMatchObject({
      status: "translated",
      title: firstRow?.title,
      content: firstRow?.content,
      model: firstRow?.model,
      startedAt: null,
    });
    expect(s.notified).toContain(TEST_USER.id);
  });

  it("その場の翻訳で、すべて写せると分けたあと写す元が消えていたら、分け直して送る", async () => {
    const s = await setup({ feeds });
    s.batches.transform = mark;
    const first = await translatedFirst(s);
    const third = await requestOnDemand(s, "/mirror.xml");
    const job = s.enqueued.find((j) => j.type === "translate-article");
    if (!job) throw new Error("no job");
    const hook = statementHook(
      /update article_translations set status = 'translated'/,
      async () => {
        await testDb.exec(`DELETE FROM articles WHERE id = '${first}'`);
      },
    );
    s.replies.push({ transform: mark });
    await runJob({ ...s.platform, db: hook.db }, job);
    expect(hook.fired()).toBe(true);
    expect(claudeSegments(s)).toEqual([expect.arrayContaining(["title", "b1"])]);
    expect(await translationOf(s.platform, third)).toMatchObject({
      status: "translated",
      title: "訳:GnuPG Security Advisory for GPGME",
    });
  });

  it("その場で拒否されて理由のある記事も、同じ元記事の訳が写って translated になると、理由が消える（決定の 17）", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = await setup({ feeds });
    s.batches.transform = mark;
    const first = await deliver(s, "/hn.xml");
    await maintain(s.platform);
    const third = await requestOnDemand(s, "/mirror.xml");
    s.replies.push({
      text: "",
      stop: "refusal",
      stopDetails: { type: "refusal", category: "cyber", explanation: null },
    });
    await runQueuedTranslation(s);
    expect(await translationOf(s.platform, third)).toMatchObject({
      status: "untranslated",
      failureKind: "refused",
      failureCategory: "cyber",
    });
    const batch = s.batches.list.find((b) => b.requests.some((r) => r.custom_id === first));
    if (!batch) throw new Error("the first article was not sent");
    batch.ended = true;
    await maintain(s.platform);

    s.enqueued.length = 0;
    s.claude.length = 0;
    expect((await request(s, third)).response.status).toBe(202);
    await runQueuedTranslation(s);
    expect(s.claude).toHaveLength(0);
    expect(await translationOf(s.platform, third)).toMatchObject({
      status: "translated",
      title: "訳:GnuPG Security Advisory for GPGME",
      failureKind: null,
      failureCategory: null,
      failureStage: null,
    });
  });

  it("同じ元記事の行がバッチの中にあっても、その場の翻訳は待たずに送る", async () => {
    const s = await setup({ feeds });
    const first = await deliver(s, "/hn.xml");
    await maintain(s.platform);
    expect(batchOf(s, first)).toHaveLength(1);
    const second = await requestOnDemand(s, "/lobsters.xml");
    s.replies.push({ transform: mark });
    await runQueuedTranslation(s);
    expect(claudeSegments(s)).toEqual([expect.arrayContaining(["title", "summary", "b1"])]);
    expect(await translationOf(s.platform, second)).toMatchObject({ status: "translated" });
  });

  it("その場の翻訳で、すべて写せる記事が容量の上限に当たったら、呼ばずに失敗にする", async () => {
    const s = await setup({ feeds });
    s.batches.transform = mark;
    await translatedFirst(s);
    const third = await requestOnDemand(s, "/mirror.xml");
    const job = s.enqueued.find((j) => j.type === "translate-article");
    if (!job) throw new Error("no job");
    const usage = await readStorageUsage(s.platform.db);
    await configureStorage(s.platform.db, usage.bytes + 100);
    await runJob({ ...s.platform, retentionConfig: { maxBytes: usage.bytes + 100 } }, job);
    expect(s.claude).toHaveLength(0);
    expect(await translationOf(s.platform, third)).toMatchObject({
      status: "untranslated",
      title: null,
    });
  });

  it("その場の翻訳で本文を写すときも、写す本文の分を容量に見積もり、足りなければ呼ばずに失敗にする", async () => {
    const s = await setup({ feeds });
    s.batches.transform = mark;
    await translatedFirst(s);
    const second = await requestOnDemand(s, "/lobsters.xml");
    const job = s.enqueued.find((j) => j.type === "translate-article");
    if (!job) throw new Error("no job");
    // 送る要約の分は収まるが、写す本文の分は収まらない上限
    const usage = await readStorageUsage(s.platform.db);
    await runJob({ ...s.platform, retentionConfig: { maxBytes: usage.bytes + 600 } }, job);
    expect(s.claude).toHaveLength(0);
    expect(await translationOf(s.platform, second)).toMatchObject({ status: "untranslated" });
  });

  it("訳し直しは、同じ元記事の訳があっても写さず、すべてを Opus に送る", async () => {
    const s = await setup({ feeds });
    s.batches.transform = mark;
    await translatedFirst(s);
    const second = await deliver(s, "/lobsters.xml");
    await maintain(s.platform);
    const batch = batchOf(s, second)[0];
    if (batch) batch.ended = true;
    await maintain(s.platform);
    expect(await translationOf(s.platform, second)).toMatchObject({ status: "translated" });

    s.enqueued.length = 0;
    expect((await retranslate(s, second)).response.status).toBe(202);
    s.replies.push({ transform: (segment) => `Opus:${segment.text}` });
    await runQueuedTranslation(s);
    expect(claudeSegments(s).at(-1)).toEqual(expect.arrayContaining(["title", "summary", "b1"]));
    expect(await translationOf(s.platform, second)).toMatchObject({
      title: "Opus:GnuPG Security Advisory for GPGME (T8557,CVE-2026-129975)",
      retranslated: true,
    });
  });

  // --- 訳し直しを広げる（決定の 16 の「訳し直し」） ---

  /** Opus の訳し方。容量の確かめのため、Sonnet の訳より長くする */
  const opusMark: Transform = (segment) => `Opus で丁寧に訳し直した訳文：${segment.text}`;

  /** 後の記事を、バッチで（すべて写せれば写して）訳し終える */
  async function translatedLater(s: Setup, path: string, page: string | null = GPGME_PAGE) {
    const id = await deliver(s, path, page);
    await maintain(s.platform);
    for (const batch of batchOf(s, id)) batch.ended = true;
    await maintain(s.platform);
    expect(await translationOf(s.platform, id)).toMatchObject({ status: "translated" });
    return id;
  }

  /** 訳し直しを求め、その仕事を動かす（Opus の訳） */
  async function retranslateNow(
    s: Setup,
    id: string,
    platform: Platform = s.platform,
    transform: Transform = opusMark,
  ) {
    s.enqueued.length = 0;
    expect((await retranslate(s, id)).response.status).toBe(202);
    const job = s.enqueued.find((j) => j.type === "translate-article" && j.articleId === id);
    if (!job) throw new Error("no retranslation job");
    s.replies.push({ transform });
    await runJob(platform, job);
    const row = await translationOf(s.platform, id);
    expect(row).toMatchObject({ retranslated: true, model: "claude-opus-5-5" });
    return row;
  }

  async function syncCursor(s: Setup) {
    const response = await requestApp(s.platform, "/api/v1/sync");
    return ((await response.json()) as { cursor: string }).cursor;
  }

  it("訳し直すと、本文の指紋が同じ同じ元記事の記事にも、訳し直したタイトルと本文が写って印が付き、原文の要約が同じ記事にだけ要約も写る。持つ人に届き、知らされる", async () => {
    const s = await setup({ feeds });
    s.batches.transform = mark;
    const first = await translatedFirst(s);
    const second = await translatedLater(s, "/lobsters.xml");
    const copy = await translatedLater(s, "/hn-copy.xml");
    const secondBefore = await translationOf(s.platform, second);
    const cursor = await syncCursor(s);
    s.notified.length = 0;

    const opusRow = await retranslateNow(s, first);
    // Opus に送ったのは、求めた記事の 1 回だけ
    expect(s.claude).toHaveLength(1);
    expect(opusRow?.title).toBe("Opus で丁寧に訳し直した訳文：GnuPG Security Advisory for GPGME");
    expect(await translationOf(s.platform, second)).toMatchObject({
      status: "translated",
      title: opusRow?.title,
      // 原文の要約が違うので、要約は変わらない
      summary: secondBefore?.summary,
      content: opusRow?.content,
      contentSource: "page",
      model: "claude-opus-5-5",
      translatedAt: opusRow?.translatedAt,
      retranslated: true,
    });
    expect(await translationOf(s.platform, copy)).toMatchObject({
      title: opusRow?.title,
      summary: opusRow?.summary,
      content: opusRow?.content,
      retranslated: true,
    });
    expect(s.notified).toContain(TEST_USER.id);
    const response = await requestApp(
      s.platform,
      `/api/v1/sync?cursor=${encodeURIComponent(cursor)}`,
    );
    const body = (await response.json()) as {
      articles: { id: string; translation: { title: string; retranslated: boolean } | null }[];
    };
    for (const id of [second, copy]) {
      expect(body.articles.find((a) => a.id === id)?.translation).toMatchObject({
        title: opusRow?.title,
        retranslated: true,
      });
    }

    // 写した記事は、もう訳し直せない
    const refused = await retranslate(s, second);
    expect(refused.response.status).toBe(409);
    expect(refused.body.error?.code).toBe("retranslation_not_allowed");
  });

  it("本文の指紋が違う同じ元記事の記事と、指紋のない記事（この決まりより前に訳した記事）には写さない", async () => {
    const s = await setup({ feeds });
    s.batches.transform = mark;
    const first = await translatedFirst(s);
    const other = await translatedLater(s, "/lobsters.xml", "<p>A different page.</p>");
    const old = await translatedLater(s, "/hn-copy.xml");
    await testDb.exec(
      `UPDATE article_translations SET body_hash = NULL WHERE article_id = '${old}'`,
    );
    const before = [await translationOf(s.platform, other), await translationOf(s.platform, old)];

    await retranslateNow(s, first);
    await maintain(s.platform);
    expect([await translationOf(s.platform, other), await translationOf(s.platform, old)]).toEqual(
      before,
    );
  });

  it("写す途中で落ちても、訳し直しは済み、次の定期実行で残りの記事に写して知らせる", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = await setup({ feeds });
    s.batches.transform = mark;
    const first = await translatedFirst(s);
    const second = await translatedLater(s, "/lobsters.xml");
    const hook = statementHook(/update article_translations as t/, async () => {
      throw new Error("the process went down");
    });

    const opusRow = await retranslateNow(s, first, { ...s.platform, db: hook.db });
    expect(hook.fired()).toBe(true);
    expect(warn).toHaveBeenCalled();
    expect(await translationOf(s.platform, second)).toMatchObject({ retranslated: false });

    // 写すのは呼ばないので、API キーがなくても定期実行が写す
    s.notified.length = 0;
    const { translator: _removed, ...withoutKey } = s.platform;
    await maintain(withoutKey);
    expect(await translationOf(s.platform, second)).toMatchObject({
      title: opusRow?.title,
      content: opusRow?.content,
      retranslated: true,
    });
    expect(s.notified).toContain(TEST_USER.id);
  });

  it("原文にタイトルのない記事には、タイトルを写さない", async () => {
    const s = await setup({ feeds });
    s.batches.transform = mark;
    const first = await translatedFirst(s);
    const untitledId = await translatedLater(s, "/untitled.xml");
    expect(await translationOf(s.platform, untitledId)).toMatchObject({ title: null });

    const opusRow = await retranslateNow(s, first);
    expect(await translationOf(s.platform, untitledId)).toMatchObject({
      title: null,
      content: opusRow?.content,
      retranslated: true,
    });
  });

  it("写す元に訳し直した本文がなければ、訳した本文のある記事には写さず、印も付けない", async () => {
    const s = await setup({ feeds });
    s.batches.transform = mark;
    const first = await translatedFirst(s);
    const second = await translatedLater(s, "/lobsters.xml");
    const secondBefore = await translationOf(s.platform, second);
    // 訳し直した本文が上限を超えて置けなかった（作りにくいので、写す先を読む直前に本文を外す）
    const hook = statementHook(/select distinct t\.article_id/, async () => {
      await testDb.exec(
        `UPDATE article_translations SET content = NULL, content_source = NULL WHERE article_id = '${first}'`,
      );
    });

    await retranslateNow(s, first, { ...s.platform, db: hook.db });
    expect(hook.fired()).toBe(true);
    expect(await translationOf(s.platform, second)).toEqual(secondBefore);
    // 写す先に選ばないので、定期実行も写そうとしない（100 行の枠を埋めない）
    const copying = statementHook(/update article_translations as t/, async () => {});
    await maintain({ ...s.platform, db: copying.db });
    expect(copying.fired()).toBe(false);
    expect(await translationOf(s.platform, second)).toEqual(secondBefore);
    // 印がないので、後の記事は自分で訳し直せる
    expect((await retranslate(s, second)).response.status).toBe(202);
  });

  it("容量の上限に当たった記事には写さず、空いたあとの定期実行で写す", async () => {
    const s = await setup({ feeds });
    s.batches.transform = mark;
    const first = await translatedFirst(s);
    const second = await translatedLater(s, "/lobsters.xml");
    const secondBefore = await translationOf(s.platform, second);
    const { limitBytes } = await readStorageUsage(s.platform.db);
    // 訳し直した行を書いたあと、写す直前に上限に達する
    const hook = statementHook(/update article_translations as t/, async () => {
      await testDb.exec("UPDATE storage_usage SET limit_bytes = bytes WHERE id = 1");
    });

    const opusRow = await retranslateNow(s, first, { ...s.platform, db: hook.db });
    expect(hook.fired()).toBe(true);
    expect(await translationOf(s.platform, second)).toEqual(secondBefore);

    await configureStorage(s.platform.db, limitBytes);
    await maintain(s.platform);
    expect(await translationOf(s.platform, second)).toMatchObject({
      title: opusRow?.title,
      content: opusRow?.content,
      retranslated: true,
    });
  });

  it("そのとき translated でなかった記事（自分の訳し直しの最中）は、その訳し直しが失敗して戻ったあとの定期実行で写す", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = await setup({ feeds });
    s.batches.transform = mark;
    const first = await translatedFirst(s);
    const second = await translatedLater(s, "/lobsters.xml");
    s.enqueued.length = 0;
    expect((await retranslate(s, second)).response.status).toBe(202);
    const secondJob = s.enqueued.find((j) => j.type === "translate-article");
    if (!secondJob) throw new Error("no retranslation job");

    const opusRow = await retranslateNow(s, first);
    expect(await translationOf(s.platform, second)).toMatchObject({
      status: "translating",
      retranslated: false,
    });
    // 後の記事の訳し直しは拒否され、もとの訳文のまま translated に戻る
    s.replies.push({ text: "", stop: "refusal" });
    await runJob(s.platform, secondJob);
    expect(await translationOf(s.platform, second)).toMatchObject({
      status: "translated",
      retranslated: false,
    });

    await maintain(s.platform);
    expect(await translationOf(s.platform, second)).toMatchObject({
      title: opusRow?.title,
      content: opusRow?.content,
      retranslated: true,
    });
  });

  it("訳し直したあとにバッチの結果を書く同じ元記事の記事は、訳し直した訳を写す", async () => {
    const s = await setup({ feeds });
    s.batches.transform = mark;
    const first = await translatedFirst(s);
    const second = await deliver(s, "/lobsters.xml");
    await maintain(s.platform);
    expect(batchOf(s, second)).toHaveLength(1);

    const opusRow = await retranslateNow(s, first);
    for (const batch of batchOf(s, second)) batch.ended = true;
    await maintain(s.platform);
    expect(await translationOf(s.platform, second)).toMatchObject({
      status: "translated",
      title: opusRow?.title,
      summary: "訳:Comments",
      content: opusRow?.content,
      retranslated: true,
    });
  });

  it("両方に本文がない記事には、訳し直したタイトルを写して印を付ける。タイトルも写せなければ写さず、印も付けない", async () => {
    for (const [transform, copied] of [
      [opusMark, true],
      // Opus がタイトルを返さず、原文のまま
      [() => undefined, false],
    ] as [Transform, boolean][]) {
      await testDb.exec("DELETE FROM feeds");
      const s = await setup({ feeds });
      s.batches.transform = mark;
      const source = await translatedLater(s, "/mirror.xml", null);
      const target = await translatedLater(s, "/mirror2.xml", null);
      const before = await translationOf(s.platform, target);
      expect(before).toMatchObject({ bodyHash: NO_BODY_HASH, content: null, retranslated: false });

      const opusRow = await retranslateNow(s, source, s.platform, transform);
      await maintain(s.platform);
      if (copied) {
        expect(await translationOf(s.platform, target)).toMatchObject({
          title: opusRow?.title,
          content: null,
          model: "claude-opus-5-5",
          retranslated: true,
        });
      } else {
        expect(opusRow?.title).toBe("GnuPG Security Advisory for GPGME");
        expect(await translationOf(s.platform, target)).toEqual(before);
      }
    }
  });

  it("定期実行で写すところが落ちても、ほかの手入れは続け、次の定期実行で写す", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = await setup({ feeds });
    s.batches.transform = mark;
    const first = await translatedFirst(s);
    const second = await translatedLater(s, "/lobsters.xml");
    const failing = () =>
      statementHook(/update article_translations as t/, async () => {
        throw new Error("the disk is busy");
      });
    const opusRow = await retranslateNow(s, first, { ...s.platform, db: failing().db });
    const third = await deliver(s, "/mirror.xml");

    const hook = failing();
    await maintain({ ...s.platform, db: hook.db });
    expect(hook.fired()).toBe(true);
    expect(await translationOf(s.platform, second)).toMatchObject({ retranslated: false });
    // 決める・送る（すべて写せる記事を写す）は続く
    expect(await translationOf(s.platform, third)).toMatchObject({
      status: "translated",
      title: opusRow?.title,
    });

    await maintain(s.platform);
    expect(await translationOf(s.platform, second)).toMatchObject({
      title: opusRow?.title,
      retranslated: true,
    });
  });
});

describe("訳せなかった理由（docs/decisions/translation.md の 17）", () => {
  /** 実際の拒否の応答の stop_details の形（記事 007f6c3e-… の Translate で返ったもの） */
  const cyber = {
    type: "refusal" as const,
    category: "cyber",
    explanation:
      "This request was flagged as potentially related to cyber harm. Learn more: https://support.claude.com/",
  };
  const refusedBy = (stopDetails: Reply["stopDetails"]): Reply => ({
    text: "",
    stop: "refusal",
    ...(stopDetails !== undefined && { stopDetails }),
  });
  const reasonOf = async (s: Setup, id: string) => {
    const row = await translationOf(s.platform, id);
    return {
      status: row?.status,
      kind: row?.failureKind ?? null,
      category: row?.failureCategory ?? null,
      stage: row?.failureStage ?? null,
    };
  };
  const reason = (
    status: string,
    kind: "refused" | "failed" | null,
    category: string | null,
    stage: "batch" | "on_demand" | null,
  ) => ({ status, kind, category, stage });
  const noReason = (status: string) => reason(status, null, null, null);

  /** 訳すかどうかを決め（バッチには送らない）、英語の記事のその場の翻訳を受け付ける */
  async function onDemand(s: Setup): Promise<string> {
    await decideTranslations(s.platform.db);
    const id = await articleId(s.platform, "en");
    s.enqueued.length = 0;
    expect((await request(s, id)).response.status).toBe(202);
    return id;
  }

  type SyncedTranslation = {
    status: string;
    failure: { kind: string; category: string | null; stage: string } | null;
  } | null;
  /** 差分同期を 1 回呼び、その記事に届いた翻訳（届かなければ undefined）と次のカーソルを返す */
  async function synced(s: Setup, id: string, cursor?: string) {
    const query = cursor === undefined ? "" : `?cursor=${encodeURIComponent(cursor)}`;
    const response = await requestApp(s.platform, `/api/v1/sync${query}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      cursor: string;
      articles: { id: string; translation?: SyncedTranslation }[];
    };
    return {
      cursor: body.cursor,
      translation: body.articles.find((a) => a.id === id)?.translation,
    };
  }

  /** そのバッチを終えて、記事ごとの結果を決める */
  function endBatch(s: Setup, index: number, results: Record<string, unknown>) {
    const batch = s.batches.list[index];
    if (!batch) throw new Error(`no batch ${index}`);
    batch.ended = true;
    batch.results = new Map(Object.entries(results));
  }
  const refusedInBatch = (stopDetails: Reply["stopDetails"] | null) => ({
    type: "succeeded",
    message: messageJson("claude-sonnet-5-5", "", "refusal", stopDetails),
  });

  it("バッチで拒否された記事は、拒否・種類・バッチの理由で untranslated になり、差分同期で届いて知らされる。説明は残さない", async () => {
    const s = await setup();
    const en = await articleId(s.platform, "en");
    await maintain(s.platform);
    const { cursor } = await synced(s, en);
    s.notified.length = 0;
    endBatch(s, 0, { [en]: refusedInBatch(cyber) });
    await maintain(s.platform);
    expect(await reasonOf(s, en)).toEqual(reason("untranslated", "refused", "cyber", "batch"));
    expect(JSON.stringify(await translationOf(s.platform, en))).not.toContain("support.claude.com");
    expect(s.notified).toContain(TEST_USER.id);
    const after = await synced(s, en, cursor);
    expect(after.translation).toMatchObject({
      status: "untranslated",
      failure: { kind: "refused", category: "cyber", stage: "batch" },
    });
    expect(JSON.stringify(after.translation)).not.toContain("explanation");
  });

  it("stop_details のない拒否は、種類が空で残る", async () => {
    const s = await setup();
    const en = await articleId(s.platform, "en");
    await maintain(s.platform);
    endBatch(s, 0, { [en]: refusedInBatch(null) });
    await maintain(s.platform);
    expect(await reasonOf(s, en)).toEqual(reason("untranslated", "refused", null, "batch"));
  });

  it("バッチで 3 回目も訳せなかった記事は、そのほかの失敗・バッチで残る。2 回目までは理由を書かない", async () => {
    const s = await setup();
    const en = await articleId(s.platform, "en");
    await maintain(s.platform);
    for (let i = 0; i < 3; i++) {
      if (i > 0) expect(await reasonOf(s, en)).toEqual(noReason("queued"));
      endBatch(s, i, { [en]: { type: "expired" } });
      await maintain(s.platform);
    }
    expect(await reasonOf(s, en)).toEqual(reason("untranslated", "failed", null, "batch"));
  });

  it("訳すものがなく送らずに untranslated にした記事と、言語が判定できなかった記事には、理由を付けない", async () => {
    const s = await setup();
    const en = await articleId(s.platform, "en");
    const und = await articleId(s.platform, "und");
    // タイトルも要約も本文もない記事（作るのに手間がかかるので、記事の行を直接書き換える）
    await s.platform.db
      .update(articles)
      .set({ title: null, summary: null, contentKey: null })
      .where(eq(articles.id, en))
      .run();
    await maintain(s.platform);
    expect(s.batches.list).toHaveLength(0);
    expect(await reasonOf(s, en)).toEqual(noReason("untranslated"));
    expect(await reasonOf(s, und)).toEqual(noReason("untranslated"));
    expect((await synced(s, und)).translation).toMatchObject({
      status: "untranslated",
      failure: null,
    });
  });

  it("その場の翻訳で、代わりのモデルも拒否したら、その応答の拒否の種類で、拒否・その場の翻訳の理由が残る", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = await setup();
    const id = await onDemand(s);
    s.replies.push({ ...refusedBy(cyber), declinedText: '{"segments":[' });
    await runQueuedTranslation(s);
    expect(await reasonOf(s, id)).toEqual(reason("untranslated", "refused", "cyber", "on_demand"));
  });

  it.each([
    ["上限で切れた応答", { text: '{"segments":[', stop: "max_tokens" }],
    ["要求の形の誤り（400）", { status: 400, errorType: "invalid_request_error" }],
  ] satisfies [string, Reply][])(
    "その場の翻訳で、%s は、そのほかの失敗・その場の翻訳で残る",
    async (_name, reply) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const s = await setup();
      const id = await onDemand(s);
      s.replies.push(reply);
      await runQueuedTranslation(s);
      expect(await reasonOf(s, id)).toEqual(reason("untranslated", "failed", null, "on_demand"));
    },
  );

  it("その場の翻訳で、やり直せる失敗の 3 回目は、そのほかの失敗・その場の翻訳で残る。やり直す間は書かない", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = await setup();
    const id = await onDemand(s);
    const overloaded: Reply = { status: 529, errorType: "overloaded_error" };
    s.replies.push(overloaded, overloaded, overloaded);
    await expect(runQueuedTranslation(s)).rejects.toThrow();
    await expect(runQueuedTranslation(s)).rejects.toThrow();
    expect(await reasonOf(s, id)).toEqual(noReason("translating"));
    await runQueuedTranslation(s);
    expect(await reasonOf(s, id)).toEqual(reason("untranslated", "failed", null, "on_demand"));
  });

  it("その場の翻訳で、送るものがない・容量が足りない・キーを外した記事は、そのほかの失敗・その場の翻訳で残る", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const job = (s: Setup) => {
      const found = s.enqueued.find((j) => j.type === "translate-article");
      if (!found) throw new Error("no job");
      return found;
    };
    // 送るもの（タイトル、要約、本文）がない
    {
      const s = await setup();
      const id = await onDemand(s);
      await s.platform.db
        .update(articles)
        .set({ title: null, summary: null, contentKey: null })
        .where(eq(articles.id, id))
        .run();
      await runJob(s.platform, job(s));
      expect(s.claude).toHaveLength(0);
      expect(await reasonOf(s, id)).toEqual(reason("untranslated", "failed", null, "on_demand"));
    }
    // 容量が足りない（上限ちょうど。理由を書くことは容量で止まらない）
    {
      await testDb.exec("DELETE FROM feeds");
      const s = await setup();
      const id = await onDemand(s);
      const usage = await readStorageUsage(s.platform.db);
      await runJob({ ...s.platform, retentionConfig: { maxBytes: usage.bytes } }, job(s));
      expect(s.claude).toHaveLength(0);
      expect(await reasonOf(s, id)).toEqual(reason("untranslated", "failed", null, "on_demand"));
    }
    // キーを外した
    {
      await testDb.exec("DELETE FROM feeds");
      const s = await setup();
      const id = await onDemand(s);
      const { translator: _removed, ...withoutKey } = s.platform;
      await runJob(withoutKey, job(s));
      expect(await reasonOf(s, id)).toEqual(reason("untranslated", "failed", null, "on_demand"));
    }
  });

  it("容量が上限ちょうどでも、バッチの拒否で untranslated に移り、理由が残る", async () => {
    const s = await setup();
    const en = await articleId(s.platform, "en");
    await maintain(s.platform);
    endBatch(s, 0, { [en]: refusedInBatch(cyber) });
    const usage = await readStorageUsage(s.platform.db);
    await maintain({ ...s.platform, retentionConfig: { maxBytes: usage.bytes } });
    expect(await reasonOf(s, en)).toEqual(reason("untranslated", "refused", "cyber", "batch"));
  });

  it("止まった translating を訳文のないまま戻すと、そのほかの失敗・その場の翻訳で残る", async () => {
    const s = await setup();
    const id = await onDemand(s);
    await s.platform.db
      .update(articleTranslations)
      .set({ startedAt: new Date(Date.now() - 2 * 60 * 60 * 1000) })
      .where(eq(articleTranslations.articleId, id))
      .run();
    await maintain(s.platform);
    expect(await reasonOf(s, id)).toEqual(reason("untranslated", "failed", null, "on_demand"));
  });

  it("理由のある記事のその場の翻訳を受け付けても、translating の間は理由が残り（配らない）、訳せたら消えて届く", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = await setup();
    const id = await onDemand(s);
    s.replies.push(refusedBy(cyber));
    await runQueuedTranslation(s);
    const { cursor } = await synced(s, id);

    s.enqueued.length = 0;
    expect((await request(s, id)).response.status).toBe(202);
    expect(await reasonOf(s, id)).toEqual(reason("translating", "refused", "cyber", "on_demand"));
    const during = await synced(s, id, cursor);
    expect(during.translation).toMatchObject({ status: "translating", failure: null });

    await runQueuedTranslation(s);
    expect(await reasonOf(s, id)).toEqual(noReason("translated"));
    expect((await synced(s, id, during.cursor)).translation).toMatchObject({
      status: "translated",
      failure: null,
    });
  });

  it("理由のある記事をもう一度その場で訳して、また訳せなければ、新しい理由で書き換わる", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = await setup();
    const id = await onDemand(s);
    s.replies.push(refusedBy(cyber));
    await runQueuedTranslation(s);

    s.enqueued.length = 0;
    expect((await request(s, id)).response.status).toBe(202);
    s.replies.push({ status: 400, errorType: "invalid_request_error" });
    await runQueuedTranslation(s);
    expect(await reasonOf(s, id)).toEqual(reason("untranslated", "failed", null, "on_demand"));
  });

  it("理由のある記事のその場の翻訳を、仕事を積めずに取り消したら、もとの理由のまま untranslated に戻る", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = await setup();
    const id = await onDemand(s);
    s.replies.push(refusedBy(cyber));
    await runQueuedTranslation(s);
    const platform: Platform = {
      ...s.platform,
      jobs: {
        async enqueue() {
          throw new Error("queue is busy");
        },
      },
    };
    const response = await requestApp(platform, `/api/v1/articles/${id}/translation`, {
      method: "POST",
    });
    expect(response.status).toBe(500);
    expect(await reasonOf(s, id)).toEqual(reason("untranslated", "refused", "cyber", "on_demand"));
    expect((await synced(s, id)).translation).toMatchObject({
      status: "untranslated",
      failure: { kind: "refused", category: "cyber", stage: "on_demand" },
    });
  });

  it("その場の翻訳で拒否された記事に、あとからバッチの拒否・回数切れが届いても、理由は書き換わらない", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = await setup();
    const en = await articleId(s.platform, "en");
    await maintain(s.platform);
    // バッチで 2 回訳せず、3 回目のバッチを送ったところ
    for (let i = 0; i < 2; i++) {
      endBatch(s, i, { [en]: { type: "expired" } });
      await maintain(s.platform);
    }
    expect(s.batches.list).toHaveLength(3);
    s.enqueued.length = 0;
    expect((await request(s, en)).response.status).toBe(202);
    s.replies.push(refusedBy({ type: "refusal", category: "bio", explanation: null }));
    await runQueuedTranslation(s);
    const onDemandReason = reason("untranslated", "refused", "bio", "on_demand");
    expect(await reasonOf(s, en)).toEqual(onDemandReason);

    // 回数切れ（3 回目）
    endBatch(s, 2, { [en]: { type: "expired" } });
    await maintain(s.platform);
    expect(await translationOf(s.platform, en)).toMatchObject({ batchAttempts: 3 });
    expect(await reasonOf(s, en)).toEqual(onDemandReason);
  });

  it("その場の翻訳で拒否された記事に、あとからバッチの拒否が届いても、理由は書き換わらない", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = await setup();
    const en = await articleId(s.platform, "en");
    await maintain(s.platform);
    s.enqueued.length = 0;
    expect((await request(s, en)).response.status).toBe(202);
    s.replies.push(refusedBy(undefined));
    await runQueuedTranslation(s);
    endBatch(s, 0, { [en]: refusedInBatch(cyber) });
    await maintain(s.platform);
    expect(await reasonOf(s, en)).toEqual(reason("untranslated", "refused", null, "on_demand"));
  });

  it("その場で訳せなかった記事に、送ってあったバッチの訳文が届くと、translated になって理由が消える", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = await setup();
    const en = await articleId(s.platform, "en");
    await maintain(s.platform);
    s.enqueued.length = 0;
    expect((await request(s, en)).response.status).toBe(202);
    s.replies.push(refusedBy(cyber));
    await runQueuedTranslation(s);
    const { cursor } = await synced(s, en);
    endBatch(s, 0, {});
    await maintain(s.platform);
    expect(await reasonOf(s, en)).toEqual(noReason("translated"));
    expect((await synced(s, en, cursor)).translation).toMatchObject({
      status: "translated",
      failure: null,
    });
  });

  it("止まった訳し直しを戻して translated に戻った記事には、理由を付けない", async () => {
    const s = await setup();
    const id = await onDemand(s);
    await runQueuedTranslation(s);
    s.enqueued.length = 0;
    expect((await retranslate(s, id)).response.status).toBe(202);
    await s.platform.db
      .update(articleTranslations)
      .set({ startedAt: new Date(Date.now() - 2 * 60 * 60 * 1000) })
      .where(eq(articleTranslations.articleId, id))
      .run();
    await maintain(s.platform);
    expect(await reasonOf(s, id)).toEqual(noReason("translated"));
  });

  it("訳し直しが失敗して translated に戻った記事には、理由を付けない", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = await setup();
    const id = await onDemand(s);
    await runQueuedTranslation(s);
    s.enqueued.length = 0;
    expect((await retranslate(s, id)).response.status).toBe(202);
    s.replies.push(refusedBy(cyber));
    await runQueuedTranslation(s);
    expect(await reasonOf(s, id)).toEqual(noReason("translated"));
  });
});
