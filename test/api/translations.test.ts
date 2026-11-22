import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordExtractedPageContent } from "../../src/db/page-contents";
import { articles, articleTranslations, feeds, userArticles } from "../../src/db/schema";
import { readStorageUsage } from "../../src/db/storage";
import { BATCH_MARK_TTL_MS, decideTranslations } from "../../src/db/translations";
import { runJob } from "../../src/jobs";
import { runFetchFeed } from "../../src/jobs/fetch-feed";
import type { Job } from "../../src/jobs/job";
import { runScheduled } from "../../src/jobs/schedule";
import type { LanguageDetectionResult, Platform } from "../../src/platform";
import { createClaudeTranslator, DEFAULT_TRANSLATION_MODEL } from "../../src/translation/claude";
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
    if (html.includes("Codemods")) return { ...base, language: "en", status: "detected" };
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
        delta: { stop_reason: reply.stop ?? "end_turn", stop_sequence: null },
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

/** Models API の一覧の 1 件（実際の応答の形） */
const modelInfo = (id: string, createdAt: string) => ({
  type: "model",
  id,
  display_name: id,
  created_at: createdAt,
});

/** Models API の応答（実際の形。1 ページで返す） */
function modelsResponse(models: ReturnType<typeof modelInfo>[]): Response {
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
const messageJson = (model: string, text: string, stop = "end_turn") => ({
  id: "msg_batch",
  type: "message",
  role: "assistant",
  model,
  content: [{ type: "text", text }],
  stop_reason: stop,
  stop_sequence: null,
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
    /** 固定のモデル（TRANSLATION_MODEL） */
    model?: string;
    /** Models API の最初の答え */
    models?: () => Response;
    /** 英語の項目をこれだけ足す（guid は en-0、en-1…） */
    extraEnglish?: number;
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
        apiKey: "sk-test-secret",
        ...(options.model !== undefined && { model: options.model }),
        fetch: fake.fetch,
        now: () => new Date(clock.ms),
        ...(options.callTimeoutMs !== undefined && { callTimeoutMs: options.callTimeoutMs }),
      }),
    }),
  };
  const feed = await subscribeFeed(platform, { url: `https://${FEED_HOST}/feed.xml` });
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

  it("TRANSLATION_MODEL を書くと、一覧を見ずにそのモデルで送る", async () => {
    const s = await setup({ model: "claude-sonnet-4-5" });
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
    expect(sentModels(s)).toEqual([DEFAULT_TRANSLATION_MODEL]);
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
      { model: "claude-sonnet-4-5" },
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
      output_config: { effort: "low", format: { type: "json_schema" } },
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
    // 作れたかどうか分からない失敗（ID を書き留める前に落ちたのと同じく、印が残る）
    s.batches.createFailure = () =>
      Response.json({ type: "error", error: { type: "api_error", message: "x" } }, { status: 500 });
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

  it("送ったときと本文の分け方が違えば（指紋が合わない）、本文を置かずにタイトルと要約だけを書く", async () => {
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
    expect(await translationOf(s.platform, en)).toMatchObject({
      status: "translated",
      title: JA_TITLE,
      content: null,
      contentSource: null,
    });
  });

  it("API キーがない設定では、送らない", async () => {
    const s = await setup({ translator: false });
    await maintain(s.platform);
    expect(s.batches.list).toHaveLength(0);
    expect(s.claude).toHaveLength(0);
  });
});
