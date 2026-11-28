import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { insertFeed } from "../../src/db/feeds";
import { configureStorage, readStorageUsage } from "../../src/db/storage";
import {
  JUDGE_QUEUE_PER_JOB,
  JUDGE_REVISION,
  REJUDGE_ARTICLES_PER_JOB,
  recordJudgingRevisions,
  STATS_MIN_COUNT,
  TAG_SCORE_THRESHOLD,
} from "../../src/db/tag-judging";
import { runJob } from "../../src/jobs";
import { runFetchFeed } from "../../src/jobs/fetch-feed";
import type { Job } from "../../src/jobs/job";
import { runScheduled } from "../../src/jobs/schedule";
import { enqueueStalledTagJudging, rocchio, similarityStats } from "../../src/jobs/tag-judging";
import type { ArticleAnalysisInput, Platform } from "../../src/platform";
import { createSqliteJobQueue } from "../../src/platform/node/job-queue";
import { testDb } from "../db";
import {
  createTestPlatform,
  createUser,
  fakeArticleAnalysis,
  fakeFetch,
  recordingSyncUpdates,
  requestApp,
  statementHook,
  uniqueUrl,
} from "../helpers";

/*
 * 自動のタグ付けの判定し直し（docs/decisions/auto-tagging.md の 1、2、4、6、7）。記事は取得の仕事で入れ、
 * 埋め込みは解析の仕事で作る（本番と同じ道）。解析の差し替えは、記事のタイトルごとに決めたベクトルを返し、
 * タグの名前と説明の埋め込みは、文ごとに決めたベクトルを返す
 */

const DIMENSION = 256;

/** i 番目の次元だけが 1 のベクトル */
function axis(i: number): Float32Array {
  const vector = new Float32Array(DIMENSION);
  vector[i] = 1;
  return vector;
}

/** 4 番目より後ろの次元だけに散らばった、決まった乱数のベクトル（軸 0〜3 との類似度は 0） */
function noise(seed: number): Float32Array {
  const vector = new Float32Array(DIMENSION);
  let state = seed * 2_654_435_761 + 1;
  for (let i = 4; i < DIMENSION; i++) {
    state = (state * 1_103_515_245 + 12_345) % 2 ** 31;
    vector[i] = state / 2 ** 31 - 0.5;
  }
  return normalize(vector);
}

function normalize(vector: Float32Array): Float32Array {
  const length = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return vector.map((value) => value / length);
}

/** 軸 i に近いベクトル（類似度 0.9 前後） */
function near(i: number, seed: number): Float32Array {
  const base = axis(i);
  const extra = noise(seed);
  return normalize(base.map((value, index) => value * 2 + (extra[index] ?? 0)));
}

function toBytes(vector: Float32Array): Uint8Array {
  const bytes = new Uint8Array(vector.length * 4);
  const view = new DataView(bytes.buffer);
  vector.forEach((value, index) => {
    view.setFloat32(index * 4, value, true);
  });
  return bytes;
}

function fromBytes(value: Uint8Array | ArrayBuffer): Float32Array {
  // testDb（libsql）は blob を ArrayBuffer で返す
  const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : value;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Float32Array.from({ length: bytes.byteLength / 4 }, (_, i) =>
    view.getFloat32(i * 4, true),
  );
}

type Article = { title: string; embedding: Float32Array | null };

const rss = (items: readonly Article[]) =>
  `<rss version="2.0"><channel><title>Blog</title><link>https://example.com/</link>${items
    .map(
      (item) =>
        `<item><title>${item.title}</title><guid isPermaLink="false">${item.title}</guid><pubDate>${new Date().toUTCString()}</pubDate></item>`,
    )
    .join("")}</channel></rss>`;

/** Rust の記事 10 件と、関係のない記事 110 件 */
function standardArticles(prefix = ""): Article[] {
  return [
    ...Array.from({ length: 10 }, (_, i) => ({
      title: `${prefix}rust-${i}`,
      embedding: near(0, i),
    })),
    ...Array.from({ length: 110 }, (_, i) => ({
      title: `${prefix}noise-${i}`,
      embedding: noise(1_000 + i),
    })),
  ];
}

async function setup() {
  const embeddings = new Map<string, Float32Array | null>();
  const texts = new Map<string, Float32Array | null>([
    ["Rust", axis(0)],
    ["Go", axis(1)],
    ["Go。プログラミング言語", axis(2)],
  ]);
  const feeds = new Map<string, Article[]>();
  const { fetch } = fakeFetch((url) => new Response(rss(feeds.get(url.href) ?? [])));
  const articleAnalysis = fakeArticleAnalysis();
  articleAnalysis.analyze.mockImplementation(async (input: ArticleAnalysisInput) => ({
    candidates: [],
    embedding: embeddings.get(input.title ?? "") ?? null,
  }));
  articleAnalysis.embedText.mockImplementation(async (text: string) => texts.get(text) ?? null);
  const { syncUpdates, notified } = recordingSyncUpdates();
  const { platform, enqueued } = createTestPlatform({ fetch, articleAnalysis, syncUpdates });
  // 起動したときと同じく、今の判定の版と埋め込みの版を書く
  await recordJudgingRevisions(platform.db, {
    judgeRevision: JUDGE_REVISION,
    embeddingRevision: articleAnalysis.embeddingRevision,
  });
  const user = await createUser();
  const request = (path: string, method = "GET", json?: unknown, p: Platform = platform) =>
    requestApp(p, `/api/v1${path}`, { method, json, token: user.token });

  /** フィードを購読して取り込み、解析する */
  const feed = async (articles: readonly Article[]) => {
    const url = uniqueUrl();
    feeds.set(url, [...articles]);
    for (const article of articles) embeddings.set(article.title, article.embedding);
    const response = await request("/feeds", "POST", { url });
    expect(response.status).toBe(201);
    const id = ((await response.json()) as { feed: { id: string } }).feed.id;
    await runFetchFeed(platform, id);
    for (let index = 0; index < enqueued.length; ) {
      const job = enqueued[index];
      if (job?.type === "analyze-articles") {
        enqueued.splice(index, 1);
        await runJob(platform, job);
      } else {
        index++;
      }
    }
    return id;
  };

  const tag = async (name: string, description?: string) => {
    const response = await request("/tags", "POST", { name, description });
    expect(response.status).toBe(201);
    return ((await response.json()) as { tag: { id: string } }).tag.id;
  };

  /** その人の受信箱の記事の ID（同じファイルのほかのテストにも同じタイトルの記事がある） */
  const articleId = async (title: string) =>
    (await testDb
      .prepare(
        "SELECT a.id FROM articles a JOIN user_articles ua ON ua.article_id = a.id WHERE ua.user_id = ? AND a.title = ?",
      )
      .bind(user.id, title)
      .first<string>("id")) ?? "";

  const state = () =>
    testDb.prepare("SELECT * FROM tag_judging WHERE user_id = ?").bind(user.id).first<{
      revision: number;
      revised_at: number;
      cursor_created_at: number | null;
      cursor_article_id: string | null;
      finished: number;
      cursor_moved_at: number;
    }>();

  /** 版を上げてから 1 分たったことにする */
  const age = async (ms = 61_000) => {
    await testDb
      .prepare(
        "UPDATE tag_judging SET revised_at = revised_at - ?, cursor_moved_at = cursor_moved_at - ? WHERE user_id = ?",
      )
      .bind(ms, ms, user.id)
      .run();
  };

  /**
   * 積まれた判定し直しの仕事を取り出し、この人の分を返す（定期実行は、同じファイルのほかのテストの人も拾う）
   */
  const takeRejudges = () => {
    const taken: Job[] = [];
    for (let index = 0; index < enqueued.length; ) {
      const job = enqueued[index];
      if (job?.type === "rejudge-tags") {
        if (job.userId === user.id) taken.push(job);
        enqueued.splice(index, 1);
      } else {
        index++;
      }
    }
    return taken;
  };

  /** 1 分たったことにして、判定し直しの仕事を続きがなくなるまで流す。流した仕事の数を返す */
  const rejudge = async (p: Platform = platform) => {
    takeRejudges();
    await age();
    let runs = 0;
    let jobs: Job[] = [{ type: "rejudge-tags", userId: user.id }];
    while (jobs.length > 0 && runs < 20) {
      for (const job of jobs) await runJob(p, job);
      runs++;
      jobs = takeRejudges();
    }
    return runs;
  };

  /** 自動で付いた（消した印のない）記事のタイトル */
  const autoTitles = async (tagId: string) =>
    (
      await testDb
        .prepare(
          `SELECT a.title FROM article_tags g JOIN articles a ON a.id = g.article_id
          WHERE g.tag_id = ? AND g.kind = 'auto' AND g.deleted_at IS NULL ORDER BY a.title`,
        )
        .bind(tagId)
        .all<{ title: string }>()
    ).results.map((row) => row.title);

  /**
   * タグの入力を変えて版を上げる（関係のない記事を 1 件、手で付ける）。そのタグが判定し直しの対象になる
   * （変わったタグだけを判定し直す。docs/decisions/auto-tagging.md の 6）
   */
  let touched = 0;
  const touch = async (tagId: string) => {
    const id = await articleId(`noise-${100 + touched++}`);
    const response = await request(`/articles/${id}/tags/${tagId}`, "PUT", { on: true });
    expect(response.status).toBe(200);
  };

  /** 積まれた判定の仕事を取り出し、この人の分を返す */
  const takeJudges = () => {
    const taken: Job[] = [];
    for (let index = 0; index < enqueued.length; ) {
      const job = enqueued[index];
      if (job?.type === "judge-tags") {
        if (job.userId === user.id) taken.push(job);
        enqueued.splice(index, 1);
      } else {
        index++;
      }
    }
    return taken;
  };

  /** この人の判定待ちの行（積んだ番号と記事のタイトル） */
  const queue = async () =>
    (
      await testDb
        .prepare(
          `SELECT q.id, a.title FROM tag_judge_queue q JOIN articles a ON a.id = q.article_id
          WHERE q.user_id = ? ORDER BY q.id`,
        )
        .bind(user.id)
        .all<{ id: number; title: string }>()
    ).results;

  const rejudgeRemaining = async () =>
    ((await (await request("/tags")).json()) as { rejudgeRemaining: number }).rejudgeRemaining;

  return {
    platform,
    enqueued,
    notified,
    user,
    request,
    feed,
    tag,
    articleId,
    state,
    age,
    rejudge,
    takeRejudges,
    autoTitles,
    rejudgeRemaining,
    takeJudges,
    queue,
    touch,
    embeddings,
    texts,
    articleAnalysis,
  };
}

const rustTitles = Array.from({ length: 10 }, (_, i) => `rust-${i}`).sort();

describe("タグの版", () => {
  it("タグの API と手の付け外しの API で行が実際に変わったときだけ、同じ文の中で版を上げて位置を先頭に戻す", async () => {
    const t = await setup();
    await t.feed(standardArticles().slice(0, 12));
    const revision = async () => (await t.state())?.revision ?? 0;
    expect(await t.state()).toBeNull();

    const rust = await t.tag("Rust");
    expect(await revision()).toBe(1);
    // 既存のタグを返すだけの POST では上げない
    expect((await t.request("/tags", "POST", { name: "rust" })).status).toBe(200);
    expect(await revision()).toBe(1);
    // 値の変わらない PATCH では上げない
    expect((await t.request(`/tags/${rust}`, "PATCH", { name: "Rust" })).status).toBe(200);
    expect(await revision()).toBe(1);
    expect(
      (await t.request(`/tags/${rust}`, "PATCH", { name: "Rust", description: "言語" })).status,
    ).toBe(200);
    expect(await revision()).toBe(2);

    const article = await t.articleId("noise-0");
    expect((await t.request(`/articles/${article}/tags/${rust}`, "PUT", { on: true })).status).toBe(
      200,
    );
    expect(await revision()).toBe(3);
    // 同じ状態の再送では上げない
    await t.request(`/articles/${article}/tags/${rust}`, "PUT", { on: true });
    expect(await revision()).toBe(3);
    await t.request(`/articles/${article}/tags/${rust}`, "PUT", { on: false });
    expect(await revision()).toBe(4);
    expect((await t.request(`/articles/${article}/tags/${rust}`, "DELETE")).status).toBe(204);
    expect(await revision()).toBe(5);
    // 手直しのない取り消しでは上げない
    await t.request(`/articles/${article}/tags/${rust}`, "DELETE");
    expect(await revision()).toBe(5);

    // 位置を先頭に戻す
    await testDb
      .prepare(
        "UPDATE tag_judging SET cursor_created_at = 1, cursor_article_id = 'x', finished = 1 WHERE user_id = ?",
      )
      .bind(t.user.id)
      .run();
    expect((await t.request(`/tags/${rust}`, "DELETE")).status).toBe(204);
    expect(await t.state()).toMatchObject({
      revision: 6,
      cursor_created_at: null,
      cursor_article_id: null,
      finished: 0,
    });
    // 消したタグの再送では上げない
    await t.request(`/tags/${rust}`, "DELETE");
    expect(await revision()).toBe(6);
    // API で変えたら、判定し直しの仕事を積む
    expect(t.takeRejudges().length).toBeGreaterThan(0);
  });

  it("自動の書き込みと、受信箱の削除やタグの削除で付く消した印では、版を上げない", async () => {
    const t = await setup();
    const feedId = await t.feed(standardArticles());
    const rust = await t.tag("Rust");
    const manual = await t.articleId("noise-0");
    await t.request(`/articles/${manual}/tags/${rust}`, "PUT", { on: true });
    await t.rejudge();
    expect(await t.autoTitles(rust)).toEqual(rustTitles);
    const before = (await t.state())?.revision;
    // 購読をやめて受信箱の行が消えると、手直しの行にも消した印が付くが、版は上げない
    expect((await t.request(`/feeds/${feedId}`, "DELETE")).status).toBe(204);
    expect((await t.state())?.revision).toBe(before);
    // タグを消すと 1 つだけ上がる（記事のタグの連鎖では上げない）
    await t.request(`/tags/${rust}`, "DELETE");
    expect((await t.state())?.revision).toBe((before ?? 0) + 1);
  });

  it("タグを消すと、名前と説明の埋め込みとベクトルを空にする", async () => {
    const t = await setup();
    await t.feed(standardArticles());
    const rust = await t.tag("Rust");
    await t.rejudge();
    const vectorOf = () =>
      testDb
        .prepare("SELECT name_embedding, vector, name_embedding_input FROM tags WHERE id = ?")
        .bind(rust)
        .first<Record<string, unknown>>();
    expect((await vectorOf())?.vector).not.toBeNull();
    await t.request(`/tags/${rust}`, "DELETE");
    expect(await vectorOf()).toEqual({
      name_embedding: null,
      vector: null,
      name_embedding_input: null,
    });
  });
});

describe("判定し直し", () => {
  it("版を上げてから 1 分たつまでは積み直して終わり、たったらベクトルと統計を作って受信箱の全部を判定する", async () => {
    const t = await setup();
    await t.feed(standardArticles());
    const rust = await t.tag("Rust");
    // 判定し直しを始めるまでは、受信箱の全部が残り
    expect(await t.rejudgeRemaining()).toBe(120);

    t.takeRejudges();
    await runJob(t.platform, { type: "rejudge-tags", userId: t.user.id });
    expect(t.takeRejudges()).toEqual([{ type: "rejudge-tags", userId: t.user.id }]);
    expect(await t.autoTitles(rust)).toEqual([]);

    expect(await t.rejudge()).toBe(1);
    expect(await t.autoTitles(rust)).toEqual(rustTitles);
    expect(await t.state()).toMatchObject({ finished: 1 });
    expect(await t.rejudgeRemaining()).toBe(0);
    expect(t.notified).toContain(t.user.id);

    const row = await testDb
      .prepare(
        "SELECT stats_mean AS mean, stats_std_dev AS stdDev, stats_count AS count, vector FROM tags WHERE id = ?",
      )
      .bind(rust)
      .first<{ mean: number; stdDev: number; count: number; vector: Uint8Array }>();
    const expected = similarityStats(
      axis(0),
      standardArticles().map((article) => article.embedding ?? new Float32Array()),
    );
    expect(row?.count).toBe(120);
    expect(row?.mean).toBeCloseTo(expected.mean, 5);
    expect(row?.stdDev).toBeCloseTo(expected.stdDev, 5);
    expect(Array.from(fromBytes(row?.vector ?? new Uint8Array()))).toEqual(Array.from(axis(0)));
    // 正規化した値の境目：Rust の記事は係数以上、関係のない記事は下回る
    const z = (vector: Float32Array) => ((vector[0] ?? 0) - expected.mean) / expected.stdDev;
    expect(z(near(0, 0))).toBeGreaterThanOrEqual(TAG_SCORE_THRESHOLD);
    expect(z(noise(1_000))).toBeLessThan(TAG_SCORE_THRESHOLD);
  });

  it("タグのベクトルは「名前。説明」の埋め込みに、手で付けた記事の平均 0.5・外した記事の平均 0.25 の重みで足す。今の版の埋め込みのない記事は足さない", async () => {
    const t = await setup();
    await t.feed(standardArticles());
    const go = await t.tag("Go", "プログラミング言語");
    const plus = [await t.articleId("noise-1"), await t.articleId("noise-2")];
    const minus = await t.articleId("rust-0");
    const stale = await t.articleId("noise-3");
    for (const id of plus) await t.request(`/articles/${id}/tags/${go}`, "PUT", { on: true });
    await t.request(`/articles/${minus}/tags/${go}`, "PUT", { on: false });
    await t.request(`/articles/${stale}/tags/${go}`, "PUT", { on: true });
    // 古い埋め込みの版の記事（解析し直しを待っている）
    await testDb
      .prepare("UPDATE article_analyses SET embedding_revision = 0 WHERE article_id = ?")
      .bind(stale)
      .run();
    await t.rejudge();
    expect(t.articleAnalysis.embedText).toHaveBeenCalledWith("Go。プログラミング言語");
    const vector = fromBytes(
      (await testDb
        .prepare("SELECT vector FROM tags WHERE id = ?")
        .bind(go)
        .first<Uint8Array>("vector")) ?? new Uint8Array(),
    );
    const embedding = (title: string) => t.embeddings.get(title) ?? new Float32Array();
    const expected = normalize(
      axis(2).map(
        (value, i) =>
          value +
          0.5 * (((embedding("noise-1")[i] ?? 0) + (embedding("noise-2")[i] ?? 0)) / 2) -
          0.25 * (embedding("rust-0")[i] ?? 0),
      ),
    );
    for (let i = 0; i < DIMENSION; i++) expect(vector[i]).toBeCloseTo(expected[i] ?? 0, 5);
    expect(
      Array.from(
        rocchio(axis(2), [
          { on: 1, embedding: toBytes(embedding("noise-1")) },
          { on: 1, embedding: toBytes(embedding("noise-2")) },
          { on: 0, embedding: toBytes(embedding("rust-0")) },
        ]),
      ).map((value) => Number(value.toFixed(5))),
    ).toEqual(Array.from(expected).map((value) => Number(value.toFixed(5))));
  });

  it(`統計を求めた記事が ${STATS_MIN_COUNT} 件未満か、標準偏差が 0.001 未満なら自動で付けない`, async () => {
    const few = await setup();
    await few.feed(standardArticles().slice(0, STATS_MIN_COUNT - 1));
    const rust = await few.tag("Rust");
    await few.rejudge();
    expect(await few.autoTitles(rust)).toEqual([]);
    expect(await few.state()).toMatchObject({ finished: 1 });

    const same = await setup();
    await same.feed(
      Array.from({ length: STATS_MIN_COUNT }, (_, i) => ({
        title: `same-${i}`,
        embedding: axis(0),
      })),
    );
    const sameTag = await same.tag("Rust");
    await same.rejudge();
    expect(await same.autoTitles(sameTag)).toEqual([]);

    // ちょうど 100 件なら付く
    const exact = await setup();
    await exact.feed(standardArticles().slice(0, STATS_MIN_COUNT));
    const exactTag = await exact.tag("Rust");
    await exact.rejudge();
    expect(await exact.autoTitles(exactTag)).toEqual(rustTitles);
  });

  it("下回った自動の行に消した印を付け、手で付け外しした行と、埋め込みの版の古い記事の行は変えない。埋め込みが空・失敗の記事の自動の行には消した印を付ける", async () => {
    const t = await setup();
    await t.feed(standardArticles());
    const rust = await t.tag("Rust");
    await t.rejudge();
    expect(await t.autoTitles(rust)).toEqual(rustTitles);

    const ids = {
      moved: await t.articleId("rust-0"),
      manualOff: await t.articleId("rust-1"),
      stale: await t.articleId("rust-2"),
      empty: await t.articleId("rust-3"),
      manualOn: await t.articleId("noise-0"),
    };
    for (const [id, on] of [
      [ids.manualOff, false],
      [ids.manualOn, true],
    ] as const) {
      const response = await t.request(`/articles/${id}/tags/${rust}`, "PUT", { on });
      expect(response.status, await response.clone().text()).toBe(200);
    }
    const update = (sql: string, id: string, ...args: unknown[]) =>
      testDb
        .prepare(sql)
        .bind(...args, id)
        .run();
    // 記事の埋め込みが関係のないものに変わった（作り直した）
    await update(
      "UPDATE article_analyses SET embedding = ? WHERE article_id = ?",
      ids.moved,
      toBytes(noise(9)),
    );
    await update(
      "UPDATE article_analyses SET embedding_revision = 0 WHERE article_id = ?",
      ids.stale,
    );
    await update(
      "UPDATE article_analyses SET embedding = NULL, embedding_status = 'empty' WHERE article_id = ?",
      ids.empty,
    );
    await t.rejudge();
    expect(await t.autoTitles(rust)).toEqual(
      rustTitles.filter((title) => !["rust-0", "rust-1", "rust-3"].includes(title)),
    );
    const kinds = await testDb
      .prepare(
        `SELECT a.title, g.kind, g."on", g.deleted_at IS NOT NULL AS deleted FROM article_tags g
        JOIN articles a ON a.id = g.article_id WHERE g.tag_id = ? AND a.title IN ('rust-0', 'rust-1', 'rust-2', 'rust-3', 'noise-0')
        ORDER BY a.title`,
      )
      .bind(rust)
      .all();
    expect(kinds.results).toEqual([
      { title: "noise-0", kind: "manual", on: 1, deleted: 0 },
      { title: "rust-0", kind: "auto", on: 1, deleted: 1 },
      { title: "rust-1", kind: "manual", on: 0, deleted: 0 },
      { title: "rust-2", kind: "auto", on: 1, deleted: 0 },
      { title: "rust-3", kind: "auto", on: 1, deleted: 1 },
    ]);
  });

  it(`1 つの仕事で ${REJUDGE_ARTICLES_PER_JOB} 件まで判定し、続きを積む。途中の残りの数は位置よりあとの記事の数`, {
    timeout: 30_000,
  }, async () => {
    const t = await setup();
    const articles = [
      ...standardArticles(),
      ...Array.from({ length: REJUDGE_ARTICLES_PER_JOB + 1 - 120 }, (_, i) => ({
        title: `more-${i}`,
        embedding: noise(5_000 + i),
      })),
    ];
    await t.feed(articles.slice(0, 200));
    await t.feed(articles.slice(200, 400));
    await t.feed(articles.slice(400));
    const rust = await t.tag("Rust");
    t.takeRejudges();
    await t.age();
    await runJob(t.platform, { type: "rejudge-tags", userId: t.user.id });
    expect(await t.state()).toMatchObject({ finished: 0 });
    expect((await t.state())?.cursor_article_id).not.toBeNull();
    expect(await t.rejudgeRemaining()).toBe(1);
    const next = t.takeRejudges();
    expect(next).toEqual([{ type: "rejudge-tags", userId: t.user.id }]);
    for (const job of next) await runJob(t.platform, job);
    expect(await t.state()).toMatchObject({ finished: 1 });
    expect(t.takeRejudges()).toEqual([]);
    expect(await t.autoTitles(rust)).toEqual(rustTitles);
  });

  it("有効なタグがないか、受信箱が空なら、位置を終わりにして終える", async () => {
    const empty = await setup();
    await empty.tag("Rust");
    await empty.rejudge();
    expect(await empty.state()).toMatchObject({ finished: 1 });
    expect(
      await testDb
        .prepare("SELECT vector_tag_revision FROM tags WHERE user_id = ?")
        .bind(empty.user.id)
        .first<number>("vector_tag_revision"),
    ).toBe(1);

    const removed = await setup();
    await removed.feed(standardArticles().slice(0, 5));
    const rust = await removed.tag("Rust");
    await removed.request(`/tags/${rust}`, "DELETE");
    await removed.rejudge();
    expect(await removed.state()).toMatchObject({ finished: 1 });
    expect(await removed.rejudgeRemaining()).toBe(0);
  });
});

describe("判定し直しの重なり", () => {
  it("書く文の直前に版が上がったら書かず、位置も進めずに終わる。新しい版の判定し直しがやり直す", async () => {
    const t = await setup();
    await t.feed(standardArticles());
    const rust = await t.tag("Rust");
    const hook = statementHook(/insert into article_tags/i, async () => {
      await t.tag("Go");
    });
    await t.rejudge({ ...t.platform, db: hook.db });
    expect(hook.fired()).toBe(true);
    expect(await t.autoTitles(rust)).toEqual([]);
    expect(await t.state()).toMatchObject({ finished: 0, cursor_article_id: null });
    await t.rejudge();
    expect(await t.autoTitles(rust)).toEqual(rustTitles);
  });

  it("書く文の直前に受信箱の行が消えるかタグが消されたら、自動の行を書かない", async () => {
    const inbox = await setup();
    const feedId = await inbox.feed(standardArticles());
    const rust = await inbox.tag("Rust");
    const hook = statementHook(/insert into article_tags/i, async () => {
      await inbox.request(`/feeds/${feedId}`, "DELETE");
    });
    await inbox.rejudge({ ...inbox.platform, db: hook.db });
    expect(hook.fired()).toBe(true);
    expect(await inbox.autoTitles(rust)).toEqual([]);
    // 書けなかった記事から先へ進めず、続きも積まない。定期実行が拾い、新しい状態（受信箱が空）で終える
    expect(await inbox.state()).toMatchObject({ finished: 0 });
    expect(inbox.takeRejudges()).toEqual([]);
    await inbox.age(601_000);
    await runScheduled(inbox.platform, new Date("2026-11-28T05:10:00Z"));
    const picked = inbox.takeRejudges();
    expect(picked).toEqual([{ type: "rejudge-tags", userId: inbox.user.id }]);
    for (const job of picked) await runJob(inbox.platform, job);
    expect(await inbox.state()).toMatchObject({ finished: 1 });

    const tag = await setup();
    await tag.feed(standardArticles());
    const go = await tag.tag("Rust");
    const tagHook = statementHook(/insert into article_tags/i, async () => {
      await tag.request(`/tags/${go}`, "DELETE");
    });
    await tag.rejudge({ ...tag.platform, db: tagHook.db });
    expect(tagHook.fired()).toBe(true);
    expect(await tag.autoTitles(go)).toEqual([]);
  });

  it("位置を進める文の直前に版が上がったら、位置を進めずに終わる", async () => {
    const t = await setup();
    await t.feed(standardArticles());
    await t.tag("Rust");
    const hook = statementHook(/update tag_judging set\s+cursor_created_at/i, async () => {
      await t.tag("Go");
    });
    await t.rejudge({ ...t.platform, db: hook.db });
    expect(hook.fired()).toBe(true);
    expect(await t.state()).toMatchObject({ finished: 0, cursor_article_id: null, revision: 2 });
  });
});

describe("保存容量", () => {
  it("自動で行を新しく作ると 90% を超えるなら作らず、位置をその記事から先へ進めずに終える。定期実行が 10 分後に拾う", async () => {
    const t = await setup();
    await t.feed(standardArticles());
    const rust = await t.tag("Rust");
    const usage = await readStorageUsage(t.platform.db);
    // 書いたあとが 90% をわずかに超える上限
    await configureStorage(t.platform.db, Math.ceil((usage.bytes + 256) / 0.9) - 1);
    await t.rejudge();
    expect(await t.autoTitles(rust)).toEqual([]);
    const stopped = await t.state();
    expect(stopped?.finished).toBe(0);
    // Rust の記事のどれも、位置より前（判定済み）になっていない
    const passed = await testDb
      .prepare(
        `SELECT count(*) AS n FROM user_articles ua JOIN articles a ON a.id = ua.article_id
        WHERE ua.user_id = ? AND a.title LIKE 'rust-%' AND ? IS NOT NULL
          AND (ua.created_at > ? OR (ua.created_at = ? AND ua.article_id >= ?))`,
      )
      .bind(
        t.user.id,
        stopped?.cursor_article_id ?? null,
        stopped?.cursor_created_at ?? 0,
        stopped?.cursor_created_at ?? 0,
        stopped?.cursor_article_id ?? "",
      )
      .first<number>("n");
    expect(passed).toBe(0);
    expect(t.takeRejudges()).toEqual([]);

    await configureStorage(t.platform.db, 10 * 1024 ** 3);
    // 位置を最後に動かしてから 10 分たつまでは拾わない
    await enqueueStalledTagJudging(t.platform);
    expect(t.takeRejudges()).toEqual([]);
    await t.age(601_000);
    await enqueueStalledTagJudging(t.platform);
    const picked = t.takeRejudges();
    expect(picked).toEqual([{ type: "rejudge-tags", userId: t.user.id }]);
    for (const job of picked) await runJob(t.platform, job);
    expect(await t.autoTitles(rust)).toEqual(rustTitles);

    // 終わって、ベクトルが今の版なら拾わない
    await t.age(601_000);
    await enqueueStalledTagJudging(t.platform);
    expect(t.takeRejudges()).toEqual([]);
  });
});

describe("判定し直しの待ちと積み方", () => {
  it("版を上げた時刻の 1 分あとで積み、続けて変えた分は、あとの版の時刻に積み直して 1 回にまとめる（本物の仕事の表）", async () => {
    const t = await setup();
    await t.feed(standardArticles());
    let clock = Date.now();
    const queue = createSqliteJobQueue(t.platform.db, { now: () => new Date(clock) });
    const p: Platform = { ...t.platform, jobs: queue, now: () => new Date(clock) };
    const waiting = () =>
      testDb
        .prepare("SELECT run_at, attempts FROM job_queue WHERE slot = ?")
        .bind(`tag-rejudge:${t.user.id}`)
        .all<{ run_at: number; attempts: number }>();

    const rust = await (await t.request("/tags", "POST", { name: "Rust" }, p)).json();
    const [first] = (await waiting()).results;
    expect(first?.run_at).toBeGreaterThanOrEqual(clock + 59_000);
    expect(first?.run_at).toBeLessThanOrEqual(clock + 61_000);
    // 続けて変えても、未着手の仕事があれば積まない
    clock += 30_000;
    expect((await t.request("/tags", "POST", { name: "Go" }, p)).status).toBe(201);
    expect((await waiting()).results).toHaveLength(1);

    // 先の仕事が動いても、あとの版を上げてから 1 分たっていなければ積み直して終わる
    clock += 31_000;
    expect(await queue.runDue((job) => runJob(p, job))).toBe(1);
    const [again] = (await waiting()).results;
    expect(again?.attempts).toBe(0);
    expect(again?.run_at).toBeGreaterThan(clock);
    expect(await t.autoTitles((rust as { tag: { id: string } }).tag.id)).toEqual([]);

    await t.age();
    clock = (again?.run_at ?? clock) + 1;
    while ((await queue.runDue((job) => runJob(p, job))) > 0) {}
    expect(await t.autoTitles((rust as { tag: { id: string } }).tag.id)).toEqual(rustTitles);
    expect((await waiting()).results).toEqual([]);
  });

  it("定期実行は 10 分の区切りで、版を上げてから 1 分たち、位置を最後に動かしてから 10 分たった人だけを拾う", async () => {
    const t = await setup();
    await t.feed(standardArticles());
    await t.tag("Rust");
    t.takeRejudges();
    const slot = new Date("2026-11-28T05:10:00Z");
    await runScheduled(t.platform, slot);
    expect(t.takeRejudges()).toEqual([]);
    // 1 分はたったが、位置を動かしてから 10 分たっていない
    await t.age(61_000);
    await runScheduled(t.platform, slot);
    expect(t.takeRejudges()).toEqual([]);
    await t.age(600_000);
    // 10 分の区切りでなければ拾わない
    await runScheduled(t.platform, new Date("2026-11-28T05:15:00Z"));
    expect(t.takeRejudges()).toEqual([]);
    await runScheduled(t.platform, slot);
    expect(t.takeRejudges()).toEqual([{ type: "rejudge-tags", userId: t.user.id }]);
  });

  it(`受信箱がちょうど ${REJUDGE_ARTICLES_PER_JOB} 件なら、続きの仕事が空のページを見て終える`, {
    timeout: 30_000,
  }, async () => {
    const t = await setup();
    const articles = [
      ...standardArticles(),
      ...Array.from({ length: REJUDGE_ARTICLES_PER_JOB - 120 }, (_, i) => ({
        title: `more-${i}`,
        embedding: noise(7_000 + i),
      })),
    ];
    await t.feed(articles.slice(0, 200));
    await t.feed(articles.slice(200, 400));
    await t.feed(articles.slice(400));
    await t.tag("Rust");
    expect(await t.rejudge()).toBe(2);
    expect(await t.state()).toMatchObject({ finished: 1 });
  });
});

describe("統計の記事", () => {
  it("受信箱の新しい 2,000 件から求め、今の版の埋め込みのない記事（古い版・空）は数えない", {
    timeout: 60_000,
  }, async () => {
    const t = await setup();
    const feedId = `stats-${crypto.randomUUID()}`;
    await insertFeed(t.platform.db, {
      id: feedId,
      url: `https://stats.example/${feedId}`,
      now: new Date(),
    });
    const now = Date.now();
    const rows = { articles: [] as string[], inbox: [] as string[] };
    const analyses: { id: string; revision: number; embedding: Float32Array | null }[] = [];
    // 新しい順に：古い版の記事 3 件、空の記事 2 件、今の版の記事 2,000 件、さらに古い今の版の記事 50 件
    const plan = [
      ...Array.from({ length: 3 }, () => ({
        revision: 0,
        embedding: axis(0) as Float32Array | null,
      })),
      ...Array.from({ length: 2 }, () => ({ revision: 1, embedding: null })),
      ...Array.from({ length: 2_000 }, (_, i) => ({ revision: 1, embedding: noise(10_000 + i) })),
      ...Array.from({ length: 50 }, () => ({ revision: 1, embedding: axis(0) })),
    ];
    plan.forEach((item, i) => {
      const id = `${feedId}-${i}`;
      const at = now - i * 1_000;
      rows.articles.push(`('${id}', '${feedId}', '${id}', ${at}, ${at})`);
      rows.inbox.push(`('${t.user.id}', '${id}', '${feedId}', ${at}, ${at}, ${2_000_000 + i})`);
      analyses.push({ id, ...item });
    });
    for (let i = 0; i < plan.length; i += 500) {
      await testDb.exec(
        `INSERT INTO articles (id, feed_id, guid, published_at, created_at) VALUES ${rows.articles.slice(i, i + 500).join(",")}`,
      );
      await testDb.exec(
        `INSERT INTO user_articles (user_id, article_id, feed_id, published_at, created_at, seq) VALUES ${rows.inbox.slice(i, i + 500).join(",")}`,
      );
    }
    const hex = (vector: Float32Array) => Buffer.from(toBytes(vector)).toString("hex");
    const values = analyses.map(
      (item) =>
        `('${item.id}', '${feedId}', 1, 'empty', ${item.revision}, '${item.embedding ? "done" : "empty"}', ${
          item.embedding ? `X'${hex(item.embedding)}'` : "NULL"
        }, 0)`,
    );
    for (let i = 0; i < values.length; i += 200) {
      await testDb.exec(
        `INSERT INTO article_analyses (article_id, feed_id, candidate_revision, candidate_status, embedding_revision, embedding_status, embedding, analyzed_at) VALUES ${values.slice(i, i + 200).join(",")}`,
      );
    }
    const rust = await t.tag("Rust");
    await t.rejudge();
    const row = await testDb
      .prepare("SELECT stats_mean AS mean, stats_count AS count FROM tags WHERE id = ?")
      .bind(rust)
      .first<{ mean: number; count: number }>();
    expect(row?.count).toBe(2_000);
    // 新しい 2,000 件（軸 0 との類似度が 0 の記事）だけで求めたので、平均は 0
    expect(row?.mean).toBeCloseTo(0, 6);
  });
});

describe("判定し直しの重なり（続き）", () => {
  it("生き返らせる文・印を付ける文・ベクトルを書く文の直前に版が上がっても書かない", {
    timeout: 30_000,
  }, async () => {
    for (const [pattern, prepare] of [
      [/update article_tags set kind = 'auto'/i, "revive"],
      [/update article_tags set deleted_at/i, "detach"],
      [/update tags set\s+name_embedding_input/i, "vector"],
    ] as const) {
      const t = await setup();
      await t.feed(standardArticles());
      const rust = await t.tag("Rust");
      const rust0 = await t.articleId("rust-0");
      if (prepare !== "vector") {
        await t.rejudge();
        // rust-0 を関係のない記事にして、印を付ける ／ 印を付けてから元に戻して生き返らせる
        await testDb
          .prepare("UPDATE article_analyses SET embedding = ? WHERE article_id = ?")
          .bind(toBytes(noise(42)), rust0)
          .run();
        if (prepare === "revive") {
          await t.touch(rust);
          await t.rejudge();
          expect(await t.autoTitles(rust)).not.toContain("rust-0");
          await testDb
            .prepare("UPDATE article_analyses SET embedding = ? WHERE article_id = ?")
            .bind(toBytes(near(0, 0)), rust0)
            .run();
        }
        await t.touch(rust);
      }
      const before = await t.autoTitles(rust);
      const hook = statementHook(pattern, async () => {
        await t.tag(`bump-${prepare}`);
      });
      await t.rejudge({ ...t.platform, db: hook.db });
      expect(hook.fired(), prepare).toBe(true);
      expect(await t.autoTitles(rust), prepare).toEqual(before);
      expect((await t.state())?.finished, prepare).toBe(0);
    }
  });

  it("判定の途中で手で付け外しされたら、手直しの行を変えず、新しい版で判定し直す", async () => {
    const t = await setup();
    await t.feed(standardArticles());
    const rust = await t.tag("Rust");
    const rust5 = await t.articleId("rust-5");
    const hook = statementHook(/insert into article_tags/i, async () => {
      const response = await t.request(`/articles/${rust5}/tags/${rust}`, "PUT", { on: false });
      expect(response.status).toBe(200);
    });
    await t.rejudge({ ...t.platform, db: hook.db });
    expect(hook.fired()).toBe(true);
    await t.rejudge();
    expect(await t.autoTitles(rust)).toEqual(rustTitles.filter((title) => title !== "rust-5"));
    expect(
      await testDb
        .prepare(`SELECT kind, "on" FROM article_tags WHERE tag_id = ? AND article_id = ?`)
        .bind(rust, rust5)
        .first(),
    ).toEqual({ kind: "manual", on: 0 });
  });

  it("受信箱から消えた記事の手直しは、次に作り直すときにベクトルから外れる", async () => {
    const t = await setup();
    await t.feed(standardArticles());
    const otherFeed = await t.feed([{ title: "extra-0", embedding: axis(3) }]);
    const go = await t.tag("Go");
    await t.request(`/articles/${await t.articleId("extra-0")}/tags/${go}`, "PUT", { on: true });
    await t.rejudge();
    const vectorOf = async () =>
      fromBytes(
        (await testDb
          .prepare("SELECT vector FROM tags WHERE id = ?")
          .bind(go)
          .first<Uint8Array>("vector")) ?? new Uint8Array(),
      );
    expect((await vectorOf())[3]).toBeGreaterThan(0);
    expect((await t.request(`/feeds/${otherFeed}`, "DELETE")).status).toBe(204);
    // 受信箱の削除では版を上げないので、次の版上げで作り直したときに外れる
    await t.tag("Rust");
    await t.rejudge();
    expect((await vectorOf())[3]).toBe(0);
  });
});

describe("判定し直しの失敗と書かない場合", () => {
  it("結果の変わらない判定し直しは、記事のタグを書かず、知らせない", async () => {
    const t = await setup();
    await t.feed(standardArticles());
    const rust = await t.tag("Rust");
    await t.rejudge();
    const seqs = () =>
      testDb
        .prepare("SELECT article_id, seq FROM article_tags WHERE tag_id = ? ORDER BY article_id")
        .bind(rust)
        .all();
    const before = await seqs();
    // 当たる記事のない別のタグで版を上げる（Rust のベクトルと統計は変わらない）
    await t.tag("Go");
    const notified = t.notified.length;
    await t.rejudge();
    expect(await seqs()).toEqual(before);
    expect(t.notified.length).toBe(notified);
  });

  it("名前と説明の推論や自動の書き込みが途中で失敗しても、流し直すと正しい状態になる", async () => {
    const t = await setup();
    await t.feed(standardArticles());
    const rust = await t.tag("Rust");
    t.articleAnalysis.embedText.mockRejectedValueOnce(new Error("temporary"));
    await expect(t.rejudge()).rejects.toThrow("temporary");
    expect(await t.state()).toMatchObject({ finished: 0, cursor_article_id: null });

    let failed = false;
    const hook = statementHook(/insert into article_tags/i, async () => {
      failed = true;
      throw new Error("disk error");
    });
    // drizzle は例外を「Failed query」に包む
    await expect(t.rejudge({ ...t.platform, db: hook.db })).rejects.toThrow();
    expect(failed).toBe(true);
    expect(await t.state()).toMatchObject({ finished: 0 });
    await t.rejudge();
    expect(await t.autoTitles(rust)).toEqual(rustTitles);
    expect(await t.state()).toMatchObject({ finished: 1 });
  });
});

describe("保存容量（続き）", () => {
  it("書いたあとが 90% のすぐ手前なら作り、使用量によらず消した印の行は生き返らせる", async () => {
    const t = await setup();
    await t.feed(standardArticles());
    const rust = await t.tag("Rust");
    const rust0 = await t.articleId("rust-0");
    await t.rejudge();
    // rust-0 の自動の行に消した印を付ける
    await testDb
      .prepare("UPDATE article_analyses SET embedding = ? WHERE article_id = ?")
      .bind(toBytes(noise(77)), rust0)
      .run();
    await t.touch(rust);
    await t.rejudge();
    expect(await t.autoTitles(rust)).not.toContain("rust-0");

    // 新しい記事 1 件ぶんの行がちょうど入る上限（書いたあとが 90% のすぐ手前）
    const newFeed = await t.feed([{ title: "rust-new", embedding: near(0, 99) }]);
    expect(newFeed).not.toBe("");
    await testDb
      .prepare("UPDATE article_analyses SET embedding = ? WHERE article_id = ?")
      .bind(toBytes(near(0, 0)), rust0)
      .run();
    // 手で付けた行も容量に数えるので、上限は版を上げたあとで決める
    await t.touch(rust);
    const usage = await readStorageUsage(t.platform.db);
    await configureStorage(t.platform.db, Math.floor((usage.bytes + 256) / 0.9) + 1);
    await t.rejudge();
    expect(await t.autoTitles(rust)).toEqual([...rustTitles, "rust-new"].sort());
    // 上限を詰めても、消した印の行は生き返らせる
    await testDb
      .prepare("UPDATE article_analyses SET embedding = ? WHERE article_id = ?")
      .bind(toBytes(noise(78)), rust0)
      .run();
    await t.touch(rust);
    await t.rejudge();
    expect(await t.autoTitles(rust)).not.toContain("rust-0");
    await testDb
      .prepare("UPDATE article_analyses SET embedding = ? WHERE article_id = ?")
      .bind(toBytes(near(0, 0)), rust0)
      .run();
    await t.touch(rust);
    await configureStorage(t.platform.db, (await readStorageUsage(t.platform.db)).bytes);
    await t.rejudge();
    expect(await t.autoTitles(rust)).toContain("rust-0");
  });
});

describe("判定し直しの直し", () => {
  it("ベクトルを書く文の直前に、別の作り直しが同じタグを書いたら書かずに終え、流し直すと作り直す", async () => {
    const t = await setup();
    await t.feed(standardArticles());
    const rust = await t.tag("Rust");
    const hook = statementHook(/update tags set\s+name_embedding_input/i, async () => {
      await testDb
        .prepare(
          "UPDATE tags SET vector_tag_revision = (SELECT revision FROM tag_judging WHERE user_id = ?) WHERE id = ?",
        )
        .bind(t.user.id, rust)
        .run();
    });
    await t.rejudge({ ...t.platform, db: hook.db });
    expect(hook.fired()).toBe(true);
    expect(
      await testDb.prepare("SELECT vector FROM tags WHERE id = ?").bind(rust).first("vector"),
    ).toBeNull();
    expect(await t.state()).toMatchObject({ finished: 0 });
    await t.rejudge();
    expect(await t.autoTitles(rust)).toEqual(rustTitles);
  });

  it("判定し直しを終えた人は、埋め込みの版が変わってもベクトルを作り直さない（版を上げて判定し直す）", async () => {
    const t = await setup();
    await t.feed(standardArticles());
    const rust = await t.tag("Rust");
    await t.rejudge();
    t.articleAnalysis.embeddingRevision = 2;
    t.articleAnalysis.embedText.mockClear();
    await runJob(t.platform, { type: "rejudge-tags", userId: t.user.id });
    expect(t.articleAnalysis.embedText).not.toHaveBeenCalled();
    expect(
      await testDb
        .prepare("SELECT vector_embedding_revision FROM tags WHERE id = ?")
        .bind(rust)
        .first<number>("vector_embedding_revision"),
    ).toBe(1);
    expect(await t.rejudgeRemaining()).toBe(0);
  });

  it("定期実行は、未着手の判定し直しの仕事がある人を外す", async () => {
    const t = await setup();
    await t.feed(standardArticles().slice(0, 5));
    await t.tag("Rust");
    t.takeRejudges();
    await t.age(601_000);
    const slot = `tag-rejudge:${t.user.id}`;
    await testDb
      .prepare("INSERT INTO job_queue (id, job, slot, attempts, run_at) VALUES (?, ?, ?, 0, 0)")
      .bind(crypto.randomUUID(), JSON.stringify({ type: "rejudge-tags", userId: t.user.id }), slot)
      .run();
    await runScheduled(t.platform, new Date("2026-11-28T05:10:00Z"));
    expect(t.takeRejudges()).toEqual([]);
    await testDb.prepare("DELETE FROM job_queue WHERE slot = ?").bind(slot).run();
    await runScheduled(t.platform, new Date("2026-11-28T05:10:00Z"));
    expect(t.takeRejudges()).toEqual([{ type: "rejudge-tags", userId: t.user.id }]);
  });

  it("機能を入れる前からタグを持つ人の行をマイグレーションで入れ、定期実行が拾って判定し直す", async () => {
    const t = await setup();
    await t.feed(standardArticles());
    const rust = await t.tag("Rust");
    // マイグレーションの前の状態：タグはあるが、人ごとの行もベクトルもない
    await testDb.prepare("DELETE FROM tag_judging WHERE user_id = ?").bind(t.user.id).run();
    t.takeRejudges();
    const migration = readFileSync(
      fileURLToPath(new URL("../../migrations/0087_tag-judging-triggers.sql", import.meta.url)),
      "utf8",
    );
    const backfill = migration.split("--> statement-breakpoint").at(-1) ?? "";
    expect(backfill).toContain("INSERT INTO `tag_judging`");
    await testDb.exec(backfill);
    expect(await t.state()).toMatchObject({ revision: 1, finished: 0 });
    expect(await t.rejudgeRemaining()).toBe(120);
    await runScheduled(t.platform, new Date("2026-11-28T05:10:00Z"));
    const picked = t.takeRejudges();
    expect(picked).toEqual([{ type: "rejudge-tags", userId: t.user.id }]);
    for (const job of picked) await runJob(t.platform, job);
    expect(await t.autoTitles(rust)).toEqual(rustTitles);
    // 2 回流しても行は増えず、変わらない
    const before = await t.state();
    await testDb.exec(backfill);
    expect(await t.state()).toEqual(before);
  });
});

describe("ベクトルの変わったタグだけを判定し直す（#424）", () => {
  const goArticles = Array.from({ length: 6 }, (_, i) => ({
    title: `go-${i}`,
    embedding: near(1, 300 + i),
  }));
  const goTitles = goArticles.map((article) => article.title).sort();

  const hashes = (tagId: string) =>
    testDb
      .prepare(
        "SELECT vector_hash AS vectorHash, judged_hash AS judgedHash, stats_count AS statsCount FROM tags WHERE id = ?",
      )
      .bind(tagId)
      .first<{ vectorHash: string | null; judgedHash: string | null; statsCount: number }>();

  it("入力の変わらないタグは、ベクトルと統計を使い回し、判定し直さない", async () => {
    const t = await setup();
    await t.feed([...standardArticles(), ...goArticles]);
    const rust = await t.tag("Rust");
    const go = await t.tag("Go");
    await t.rejudge();
    expect(await t.autoTitles(rust)).toEqual(rustTitles);
    expect(await t.autoTitles(go)).toEqual(goTitles);
    const rustBefore = await hashes(rust);
    expect(rustBefore?.judgedHash).toBe(rustBefore?.vectorHash);
    const rustSeqs = () =>
      testDb.prepare("SELECT article_id, seq FROM article_tags WHERE tag_id = ?").bind(rust).all();
    const seqBefore = await rustSeqs();

    // 受信箱が増えても、Rust の統計は求め直さない。Go だけ入力を変える
    await t.feed([{ title: "late-0", embedding: noise(8_000) }]);
    const rust0 = await t.articleId("rust-0");
    await testDb
      .prepare("UPDATE article_analyses SET embedding = ? WHERE article_id = ?")
      .bind(toBytes(noise(8_001)), rust0)
      .run();
    t.articleAnalysis.embedText.mockClear();
    await t.touch(go);
    await t.rejudge();
    expect(t.articleAnalysis.embedText).not.toHaveBeenCalled();
    expect(await hashes(rust)).toEqual(rustBefore);
    // Rust は判定し直さないので、関係のない記事になった rust-0 の行もそのまま
    expect(await rustSeqs()).toEqual(seqBefore);
    expect(await t.autoTitles(go)).toEqual(goTitles);
    const goAfter = await hashes(go);
    expect(goAfter?.judgedHash).toBe(goAfter?.vectorHash);
    expect(goAfter?.statsCount).toBe(127);
    expect(await t.rejudgeRemaining()).toBe(0);
  });

  it("書き始める前に判定し終えたハッシュを空にし、途中で設定を元に戻しても判定し直す", async () => {
    const t = await setup();
    t.texts.set("Rust。言語", axis(0));
    await t.feed(standardArticles());
    const rust = await t.tag("Rust");
    await t.rejudge();
    const judged = (await hashes(rust))?.judgedHash;
    expect(judged).not.toBeNull();

    // 説明を変え、判定を書き始める前に落ちる
    expect(
      (await t.request(`/tags/${rust}`, "PATCH", { name: "Rust", description: "言語" })).status,
    ).toBe(200);
    // rust-0 の自動の行に消した印を付けておく（判定し直せば生き返る）。生き返らせる文の直前に落ちる
    const rust0 = await t.articleId("rust-0");
    await testDb
      .prepare("UPDATE article_tags SET deleted_at = 1 WHERE tag_id = ? AND article_id = ?")
      .bind(rust, rust0)
      .run();
    const hook = statementHook(/update article_tags set kind = 'auto'/i, async () => {
      throw new Error("crashed");
    });
    await expect(t.rejudge({ ...t.platform, db: hook.db })).rejects.toThrow();
    expect(hook.fired()).toBe(true);
    expect((await hashes(rust))?.judgedHash).toBeNull();

    // 説明を元に戻す。ハッシュは前に判定し終えたときと同じになるが、空にしてあるので判定し直す
    expect(
      (await t.request(`/tags/${rust}`, "PATCH", { name: "Rust", description: "" })).status,
    ).toBe(200);
    await t.rejudge();
    const after = await hashes(rust);
    expect(after?.vectorHash).toBe(judged);
    expect(after?.judgedHash).toBe(judged);
    // 判定し直したので、消した印を付けておいた rust-0 も生き返る
    expect(await t.autoTitles(rust)).toEqual(rustTitles);
  });

  it("たどり終えたらハッシュを先に書き、そのあとで位置を終わりにする。間で落ちても、次の仕事が位置を終わりにして終える", async () => {
    const t = await setup();
    await t.feed(standardArticles());
    const rust = await t.tag("Rust");
    // 位置を終わりにする文（120 件なので、仕事の中で最初に位置を動かす文）の直前に落ちる
    const hook = statementHook(/update tag_judging set/i, async () => {
      throw new Error("crashed");
    });
    await expect(t.rejudge({ ...t.platform, db: hook.db })).rejects.toThrow();
    expect(hook.fired()).toBe(true);
    const marked = await hashes(rust);
    expect(marked?.judgedHash).toBe(marked?.vectorHash);
    expect(await t.state()).toMatchObject({ finished: 0 });
    t.articleAnalysis.embedText.mockClear();
    expect(await t.rejudge()).toBe(1);
    expect(await t.state()).toMatchObject({ finished: 1 });
    expect(await t.autoTitles(rust)).toEqual(rustTitles);
  });

  it("対象のタグがなければ（解析の済んでいない記事を手で付けただけなど）、ベクトルを書いたあと位置を終わりにして終える", async () => {
    const t = await setup();
    await t.feed(standardArticles());
    const rust = await t.tag("Rust");
    await t.rejudge();
    const stale = await t.articleId("noise-50");
    await testDb
      .prepare("UPDATE article_analyses SET embedding_revision = 0 WHERE article_id = ?")
      .bind(stale)
      .run();
    const before = await hashes(rust);
    expect((await t.request(`/articles/${stale}/tags/${rust}`, "PUT", { on: true })).status).toBe(
      200,
    );
    expect(await t.rejudgeRemaining()).toBe(120);
    expect(await t.rejudge()).toBe(1);
    expect(await hashes(rust)).toEqual(before);
    expect(await t.state()).toMatchObject({ finished: 1 });
    expect(await t.rejudgeRemaining()).toBe(0);
  });
});

describe("手で付けた記事に埋め込みが初めて入ったときの版上げ（#424）", () => {
  it("解析の行がない記事に解析の仕事が行を入れると上げ、判定し直しで手直しがベクトルに入る", async () => {
    const t = await setup();
    await t.feed([...standardArticles(), { title: "pending-0", embedding: axis(3) }]);
    const go = await t.tag("Go");
    await t.rejudge();
    const pending = await t.articleId("pending-0");
    // 解析の行がまだない（解析を待っている）記事にする
    await testDb.prepare("DELETE FROM article_analyses WHERE article_id = ?").bind(pending).run();
    expect((await t.request(`/articles/${pending}/tags/${go}`, "PUT", { on: true })).status).toBe(
      200,
    );
    await t.rejudge();
    const vectorOf = async () =>
      fromBytes(
        (await testDb
          .prepare("SELECT vector FROM tags WHERE id = ?")
          .bind(go)
          .first<Uint8Array>("vector")) ?? new Uint8Array(),
      );
    expect((await vectorOf())[3]).toBe(0);
    const revision = async () => (await t.state())?.revision ?? 0;
    const before = await revision();

    // 解析の仕事が行を入れる（本番の書き込みの道）
    await runJob(t.platform, { type: "analyze-articles", articleIds: [pending] });
    expect(await revision()).toBe(before + 1);
    await t.rejudge();
    expect((await vectorOf())[3]).toBeGreaterThan(0);
    const hash = await testDb
      .prepare("SELECT vector_hash, judged_hash FROM tags WHERE id = ?")
      .bind(go)
      .first<{ vector_hash: string; judged_hash: string }>();
    expect(hash?.judged_hash).toBe(hash?.vector_hash);
  });

  it("埋め込みのない解析の行に、新しい版の解析が埋め込みを書くと上げ、埋め込みが変わっただけでは上げない", async () => {
    const t = await setup();
    await t.feed([...standardArticles().slice(0, 3), { title: "pending-1", embedding: null }]);
    const rust = await t.tag("Rust");
    const pending = await t.articleId("pending-1");
    expect((await t.request(`/articles/${pending}/tags/${rust}`, "PUT", { on: true })).status).toBe(
      200,
    );
    const revision = async () => (await t.state())?.revision ?? 0;
    const before = await revision();
    // 新しい埋め込みの版で解析し直すと、空だった埋め込みが入る（upsert の DO UPDATE の道）
    t.embeddings.set("pending-1", noise(9_000));
    t.articleAnalysis.embeddingRevision = 2;
    await runJob(t.platform, { type: "analyze-articles", articleIds: [pending] });
    expect(
      await testDb
        .prepare("SELECT embedding_revision FROM article_analyses WHERE article_id = ?")
        .bind(pending)
        .first<number>("embedding_revision"),
    ).toBe(2);
    expect(await revision()).toBe(before + 1);
    // さらに新しい版で埋め込みが変わっただけでは上げない
    t.embeddings.set("pending-1", noise(9_001));
    t.articleAnalysis.embeddingRevision = 3;
    await runJob(t.platform, { type: "analyze-articles", articleIds: [pending] });
    expect(await revision()).toBe(before + 1);
  });

  it("同じ記事を受信箱に持っていても、手直しのない人の版は上げない。購読をやめて受信箱にない手直しでも上げない", async () => {
    const t = await setup();
    await t.feed(standardArticles().slice(0, 3));
    // 2 人目は同じフィードを購読し、同じ記事を受信箱に持つ（手直しはしない）
    const otherUser = await createUser();
    const other = (path: string, method = "GET", json?: unknown) =>
      requestApp(t.platform, `/api/v1${path}`, { method, json, token: otherUser.token });
    const feedId = await t.feed([{ title: "pending-2", embedding: axis(3) }]);
    const feedUrl =
      (await testDb
        .prepare("SELECT url FROM feeds WHERE id = ?")
        .bind(feedId)
        .first<string>("url")) ?? "";
    expect((await other("/feeds", "POST", { url: feedUrl })).status).toBe(201);
    expect((await other("/tags", "POST", { name: "Rust" })).status).toBe(201);
    const otherRevision = async () =>
      (await testDb
        .prepare("SELECT revision FROM tag_judging WHERE user_id = ?")
        .bind(otherUser.id)
        .first<number>("revision")) ?? 0;
    const rust = await t.tag("Rust");
    const pending = await t.articleId("pending-2");
    await t.request(`/articles/${pending}/tags/${rust}`, "PUT", { on: true });
    await testDb.prepare("DELETE FROM article_analyses WHERE article_id = ?").bind(pending).run();
    const otherBefore = await otherRevision();
    const mineBefore = (await t.state())?.revision ?? 0;
    await runJob(t.platform, { type: "analyze-articles", articleIds: [pending] });
    expect((await t.state())?.revision).toBe(mineBefore + 1);
    expect(await otherRevision()).toBe(otherBefore);

    // 購読をやめると、受信箱の行が消え、手直しの行にも消した印が付く。解析し直しても上げない
    await t.request(`/feeds/${feedId}`, "DELETE");
    await testDb.prepare("DELETE FROM article_analyses WHERE article_id = ?").bind(pending).run();
    const afterUnsubscribe = (await t.state())?.revision;
    await runJob(t.platform, { type: "analyze-articles", articleIds: [pending] });
    expect((await t.state())?.revision).toBe(afterUnsubscribe);
  });
});

describe("判定し終えたハッシュを書く文の重なり（#424）", () => {
  it("ハッシュを書く文の直前に版が上がったら書かず、位置も終わりにしない。新しい版で判定し直す", async () => {
    const t = await setup();
    await t.feed(standardArticles());
    const rust = await t.tag("Rust");
    const hook = statementHook(/update tags set judged_hash/i, async () => {
      await t.tag("Go");
    });
    await t.rejudge({ ...t.platform, db: hook.db });
    expect(hook.fired()).toBe(true);
    expect(
      await testDb
        .prepare("SELECT judged_hash FROM tags WHERE id = ?")
        .bind(rust)
        .first("judged_hash"),
    ).toBeNull();
    expect(await t.state()).toMatchObject({ finished: 0, cursor_article_id: null });
    await t.rejudge();
    const row = await testDb
      .prepare("SELECT vector_hash, judged_hash FROM tags WHERE id = ?")
      .bind(rust)
      .first<{ vector_hash: string; judged_hash: string }>();
    expect(row?.judged_hash).toBe(row?.vector_hash);
    expect(await t.state()).toMatchObject({ finished: 1 });
  });
});

describe("判定待ちの表で新しい記事を判定する（#445）", () => {
  /** タグを作って判定し直しを終えた人。そのあとに入る記事を判定待ちで判定する */
  async function judged() {
    const t = await setup();
    await t.feed(standardArticles());
    const rust = await t.tag("Rust");
    await t.rejudge();
    t.takeJudges();
    expect(await t.queue()).toEqual([]);
    return { ...t, rust };
  }

  it("記事の埋め込みを保存すると、受信箱に持ち有効なタグのある人の行を積み、判定の仕事が判定して行を消す", async () => {
    const t = await judged();
    // タグのない人は同じ記事を受信箱に持っても積まない
    const other = await createUser();
    await t.feed([
      { title: "new-rust", embedding: near(0, 500) },
      { title: "new-noise", embedding: noise(9_500) },
      { title: "new-empty", embedding: null },
    ]);
    expect((await t.queue()).map((row) => row.title).sort()).toEqual([
      "new-empty",
      "new-noise",
      "new-rust",
    ]);
    expect(
      await testDb
        .prepare("SELECT count(*) AS n FROM tag_judge_queue WHERE user_id = ?")
        .bind(other.id)
        .first<number>("n"),
    ).toBe(0);
    const jobs = t.takeJudges();
    expect(jobs).toEqual([{ type: "judge-tags", userId: t.user.id }]);
    for (const job of jobs) await runJob(t.platform, job);
    expect(await t.autoTitles(t.rust)).toEqual([...rustTitles, "new-rust"].sort());
    expect(await t.queue()).toEqual([]);
    expect(t.takeJudges()).toEqual([]);
  });

  it("候補だけを作り直しても積まず、新しい埋め込みの版で保存し直すと新しい番号で積み直す", async () => {
    const t = await judged();
    await t.feed([{ title: "new-rust", embedding: near(0, 501) }]);
    const [first] = await t.queue();
    const article = await t.articleId("new-rust");
    t.articleAnalysis.candidateRevision = 2;
    await runJob(t.platform, { type: "analyze-articles", articleIds: [article] });
    expect(await t.queue()).toEqual([first]);
    t.articleAnalysis.embeddingRevision = 2;
    await runJob(t.platform, { type: "analyze-articles", articleIds: [article] });
    const [again] = await t.queue();
    expect(again?.title).toBe("new-rust");
    expect(again?.id).toBeGreaterThan(first?.id ?? 0);
  });

  it("今の版の埋め込みのある記事が受信箱に入ると積み（購読の API が判定の仕事を積む）、古い版の記事は積まない", async () => {
    const t = await setup();
    // ほかの人が先に取り込んで解析した記事
    const owner = await setup();
    const feedId = await owner.feed([
      { title: "shared-rust", embedding: near(0, 600) },
      { title: "shared-old", embedding: near(0, 601) },
    ]);
    await testDb
      .prepare(
        "UPDATE article_analyses SET embedding_revision = 0 WHERE article_id = (SELECT id FROM articles WHERE feed_id = ? AND title = 'shared-old')",
      )
      .bind(feedId)
      .run();
    // タグのない人は、記事を解析しても判定待ちに積まない
    expect(await owner.queue()).toEqual([]);
    await t.feed(standardArticles());
    const rust = await t.tag("Rust");
    await t.rejudge();
    t.takeJudges();
    const url =
      (await testDb
        .prepare("SELECT url FROM feeds WHERE id = ?")
        .bind(feedId)
        .first<string>("url")) ?? "";
    expect((await t.request("/feeds", "POST", { url })).status).toBe(201);
    expect((await t.queue()).map((row) => row.title)).toEqual(["shared-rust"]);
    const jobs = t.takeJudges();
    expect(jobs).toEqual([{ type: "judge-tags", userId: t.user.id }]);
    for (const job of jobs) await runJob(t.platform, job);
    expect(await t.autoTitles(rust)).toContain("shared-rust");
  });

  it("手直しを取り消すと、その記事を新しい番号で積み、判定し直す", async () => {
    const t = await judged();
    const rust3 = await t.articleId("rust-3");
    await t.request(`/articles/${rust3}/tags/${t.rust}`, "PUT", { on: false });
    expect(await t.queue()).toEqual([]);
    // 判定し直しの前（1 分以内）に取り消す：タグの入力は元に戻るので、判定し直しの対象にならない
    expect((await t.request(`/articles/${rust3}/tags/${t.rust}`, "DELETE")).status).toBe(204);
    expect((await t.queue()).map((row) => row.title)).toEqual(["rust-3"]);
    await t.rejudge();
    for (const job of t.takeJudges()) await runJob(t.platform, job);
    expect(await t.autoTitles(t.rust)).toEqual(rustTitles);
    expect(await t.queue()).toEqual([]);
  });

  it("タグのベクトルが今の版で作られていなければ、行に手を付けずに判定し直しを積み、判定し直しがベクトルを作ったあとで判定の仕事を積む", async () => {
    const t = await judged();
    await t.feed([{ title: "new-rust", embedding: near(0, 502) }]);
    t.takeJudges();
    await t.touch(t.rust);
    t.takeRejudges();
    await runJob(t.platform, { type: "judge-tags", userId: t.user.id });
    expect((await t.queue()).map((row) => row.title)).toEqual(["new-rust"]);
    expect(t.takeRejudges()).toEqual([{ type: "rejudge-tags", userId: t.user.id }]);
    expect(t.takeJudges()).toEqual([]);
    await t.rejudge();
    const jobs = t.takeJudges();
    expect(jobs).toEqual([{ type: "judge-tags", userId: t.user.id }]);
    for (const job of jobs) await runJob(t.platform, job);
    expect(await t.queue()).toEqual([]);
    expect(await t.autoTitles(t.rust)).toContain("new-rust");
  });

  it("処理した行は、積んだ番号とその人の版が読んだときのままのときだけ消す", async () => {
    const requeued = await judged();
    await requeued.feed([{ title: "new-rust", embedding: near(0, 503) }]);
    requeued.takeJudges();
    const article = await requeued.articleId("new-rust");
    const hook = statementHook(/delete from tag_judge_queue[\s\S]*json_each/i, async () => {
      // 判定の途中で、同じ記事が積み直された（新しい番号）
      requeued.articleAnalysis.embeddingRevision = 2;
      await runJob(requeued.platform, { type: "analyze-articles", articleIds: [article] });
      requeued.articleAnalysis.embeddingRevision = 1;
    });
    await runJob(
      { ...requeued.platform, db: hook.db },
      { type: "judge-tags", userId: requeued.user.id },
    );
    expect(hook.fired()).toBe(true);
    expect((await requeued.queue()).map((row) => row.title)).toEqual(["new-rust"]);

    const bumped = await judged();
    await bumped.feed([{ title: "new-rust", embedding: near(0, 504) }]);
    bumped.takeJudges();
    const bumpHook = statementHook(/delete from tag_judge_queue[\s\S]*json_each/i, async () => {
      await bumped.tag("Go");
    });
    await runJob(
      { ...bumped.platform, db: bumpHook.db },
      { type: "judge-tags", userId: bumped.user.id },
    );
    expect(bumpHook.fired()).toBe(true);
    expect((await bumped.queue()).map((row) => row.title)).toEqual(["new-rust"]);
  });

  it("有効なタグのない人の行は消し、受信箱の行が消えたら判定待ちの行も消える", async () => {
    const t = await judged();
    const feedId = await t.feed([{ title: "new-rust", embedding: near(0, 505) }]);
    expect(await t.queue()).toHaveLength(1);
    expect((await t.request(`/feeds/${feedId}`, "DELETE")).status).toBe(204);
    expect(await t.queue()).toEqual([]);

    await t.feed([{ title: "new-rust-2", embedding: near(0, 506) }]);
    expect(await t.queue()).toHaveLength(1);
    await t.request(`/tags/${t.rust}`, "DELETE");
    await runJob(t.platform, { type: "judge-tags", userId: t.user.id });
    expect(await t.queue()).toEqual([]);
  });

  it(`1 つの仕事で ${JUDGE_QUEUE_PER_JOB} 行まで処理し、続きを積む`, {
    timeout: 30_000,
  }, async () => {
    const t = await judged();
    const more = Array.from({ length: JUDGE_QUEUE_PER_JOB + 1 }, (_, i) => ({
      title: `queued-${i}`,
      embedding: i === 0 ? near(0, 700) : noise(10_000 + i),
    }));
    await t.feed(more.slice(0, 200));
    await t.feed(more.slice(200, 400));
    await t.feed(more.slice(400));
    t.takeJudges();
    expect(await t.queue()).toHaveLength(JUDGE_QUEUE_PER_JOB + 1);
    await runJob(t.platform, { type: "judge-tags", userId: t.user.id });
    expect(await t.queue()).toHaveLength(1);
    const next = t.takeJudges();
    expect(next).toEqual([{ type: "judge-tags", userId: t.user.id }]);
    for (const job of next) await runJob(t.platform, job);
    expect(await t.queue()).toEqual([]);
    expect(t.takeJudges()).toEqual([]);
    expect(await t.autoTitles(t.rust)).toContain("queued-0");
  });

  it("行を新しく作ると 90% を超えるなら作らず、その記事の行を残す。定期実行が判定の仕事を積む", async () => {
    const t = await judged();
    await t.feed([{ title: "new-rust", embedding: near(0, 507) }]);
    t.takeJudges();
    const usage = await readStorageUsage(t.platform.db);
    await configureStorage(t.platform.db, Math.ceil((usage.bytes + 256) / 0.9) - 1);
    await runJob(t.platform, { type: "judge-tags", userId: t.user.id });
    expect((await t.queue()).map((row) => row.title)).toEqual(["new-rust"]);
    expect(t.takeJudges()).toEqual([]);
    await configureStorage(t.platform.db, 10 * 1024 ** 3);
    await runScheduled(t.platform, new Date("2026-11-28T05:10:00Z"));
    const picked = t.takeJudges();
    expect(picked).toEqual([{ type: "judge-tags", userId: t.user.id }]);
    for (const job of picked) await runJob(t.platform, job);
    expect(await t.queue()).toEqual([]);
    expect(await t.autoTitles(t.rust)).toContain("new-rust");
  });

  it("判定し直しと判定の仕事が同じ記事に重なり、相手が先に付けていても止めずに続ける", async () => {
    const t = await judged();
    await t.feed([
      { title: "new-rust", embedding: near(0, 508) },
      { title: "new-rust-2", embedding: near(0, 509) },
    ]);
    t.takeJudges();
    const first = (await t.queue())[0];
    const firstArticle = await t.articleId(first?.title ?? "");
    const hook = statementHook(/insert into article_tags/i, async () => {
      // 判定し直しの仕事が先に同じ記事に付けた
      await testDb
        .prepare(
          `INSERT INTO article_tags (id, tag_id, user_id, article_id, kind, "on", seq)
          VALUES (?, ?, ?, ?, 'auto', 1, (SELECT coalesce(max(seq), 0) + 1 FROM article_tags))`,
        )
        .bind(crypto.randomUUID(), t.rust, t.user.id, firstArticle)
        .run();
    });
    await runJob({ ...t.platform, db: hook.db }, { type: "judge-tags", userId: t.user.id });
    expect(hook.fired()).toBe(true);
    expect(await t.queue()).toEqual([]);
    expect(await t.autoTitles(t.rust)).toEqual([...rustTitles, "new-rust", "new-rust-2"].sort());
  });

  it("ほかのタグが残ったまま 1 つのタグを消しても、連鎖で付く消した印では積まない。最後のタグを消すと判定し直しが判定待ちの行を消す", async () => {
    const t = await judged();
    const go = await t.tag("Go");
    const rust1 = await t.articleId("rust-1");
    await t.request(`/articles/${rust1}/tags/${go}`, "PUT", { on: true });
    await t.request(`/tags/${go}`, "DELETE");
    expect(await t.queue()).toEqual([]);

    await t.feed([{ title: "new-rust", embedding: near(0, 510) }]);
    t.takeJudges();
    expect(await t.queue()).toHaveLength(1);
    await t.request(`/tags/${t.rust}`, "DELETE");
    await t.rejudge();
    expect(await t.queue()).toEqual([]);
  });

  it("起動したときに書く版の行は、1 行だけで書き換える", async () => {
    const t = await setup();
    await recordJudgingRevisions(t.platform.db, { judgeRevision: 5, embeddingRevision: 7 });
    await recordJudgingRevisions(t.platform.db, {
      judgeRevision: JUDGE_REVISION,
      embeddingRevision: 1,
    });
    expect((await testDb.prepare("SELECT * FROM tag_judging_revisions").all()).results).toEqual([
      { id: 1, judge_revision: JUDGE_REVISION, embedding_revision: 1 },
    ]);
  });
});
