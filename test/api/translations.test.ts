import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { articles, articleTranslations, feeds, userArticles } from "../../src/db/schema";
import { readStorageUsage } from "../../src/db/storage";
import { runJob } from "../../src/jobs";
import { runFetchFeed } from "../../src/jobs/fetch-feed";
import type { Job } from "../../src/jobs/job";
import { runScheduled } from "../../src/jobs/schedule";
import type { LanguageDetectionResult, Platform } from "../../src/platform";
import { createClaudeTranslator } from "../../src/translation/claude";
import { testDb } from "../db";
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
const rss = (n: number) => `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>Martin Fowler</title><link>https://${FEED_HOST}/</link>
  <item><title>Refactoring with Codemods to Automate API Changes</title>
    <link>https://en-${n}.${FEED_HOST}/articles/codemods-api-refactoring.html</link><guid>en</guid>
    <description>Codemods are automated scripts that transform code to apply API changes across a large codebase, removing the manual and error-prone work of updating every call site.</description></item>
  <item><title>社内の勉強会で、リファクタリングの進め方を話した</title>
    <link>https://ja-${n}.${FEED_HOST}/ja</link><guid>ja</guid>
    <description>テストを先に書いてから、小さな変更を重ねる進め方を紹介した。</description></item>
  <item><title>OK</title><link>https://und-${n}.${FEED_HOST}/short</link><guid>und</guid></item>
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
function claudeResponse(reply: Reply, signal?: AbortSignal | null): Response {
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
        model: "claude-sonnet-5-5",
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
                from: { model: "claude-sonnet-5-5" },
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

interface Setup {
  platform: Platform;
  enqueued: Job[];
  /** Claude API に送った要求の本文とヘッダー */
  claude: { body: string; headers: Headers }[];
  replies: Reply[];
  feedId: string;
  /** WebSocket で知らせた利用者 */
  notified: string[];
}

async function setup(
  options: { translator?: boolean; callTimeoutMs?: number; subscribers?: string[] } = {},
): Promise<Setup> {
  const n = ++setups;
  const replies: Reply[] = [];
  const claude: Setup["claude"] = [];
  const fake = fakeFetch(async (url, init) => {
    if (url.hostname === "api.anthropic.com") {
      claude.push({ body: String(init?.body ?? ""), headers: new Headers(init?.headers) });
      return claudeResponse(
        replies.shift() ?? {
          text: translated([
            { id: "title", text: JA_TITLE },
            { id: "summary", text: JA_SUMMARY },
          ]),
        },
        init?.signal,
      );
    }
    if (url.pathname === "/feed.xml") return new Response(rss(n));
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
        model: "claude-sonnet-5-5",
        fetch: fake.fetch,
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
  created.enqueued.length = 0;
  recording.notified.length = 0;
  return {
    platform,
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
