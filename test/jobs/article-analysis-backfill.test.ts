import { beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { readBackfill, rewindBackfill } from "../../src/db/article-analysis-backfill";
import { insertArticles } from "../../src/db/articles";
import { insertFeed } from "../../src/db/feeds";
import { recordFailedPageContent } from "../../src/db/page-contents";
import { runJob } from "../../src/jobs";
import type { Job } from "../../src/jobs/job";
import { runScheduled } from "../../src/jobs/schedule";
import type { Platform } from "../../src/platform";
import { testDb } from "../db";
import { createTestPlatform, fakeArticleAnalysis, statementHook } from "../helpers";

/*
 * 記事の解析の遡及と拾い直し（docs/decisions/article-analysis.md の 2、4）。本番と同じく、定期実行
 * （runScheduled）が積んだ仕事を runJob で動かす。記事は直接入れ、取り込みの時刻は SQL で決める
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const BACKFILL: Job = { type: "backfill-article-analyses" };
/** 10 分の区切りの定期実行の時刻 */
const SLOT = new Date("2026-11-28T12:10:00Z");
/** 1 日 1 回の片付けを積む定期実行の時刻（日本時間 3:00） */
const DAILY = new Date("2026-11-28T18:00:00Z");

/** 本番と同じく、定期実行が積んだ 1 日 1 回の片付けを動かす */
async function runDailyCleanUp(platform: Platform, enqueued: Job[]) {
  await runScheduled(platform, DAILY);
  await runQueued(platform, enqueued, "clean-up");
  enqueued.splice(0);
}

/** 記事を入れ、取り込みの時刻を ageMs だけ前にする（並びを決めるため、1 件ずつ 1 ミリ秒ずらす） */
async function seed(
  platform: Pick<Platform, "db">,
  count: number,
  options: { ageMs?: number; url?: (i: number) => string | null; prefix?: string } = {},
) {
  await insertFeed(platform.db, {
    id: "feed",
    url: "https://example.com/feed",
    now: new Date(),
  }).catch(() => {});
  const prefix = options.prefix ?? "a";
  const ids = Array.from({ length: count }, (_, i) => `${prefix}${String(i).padStart(5, "0")}`);
  for (let i = 0; i < ids.length; i += 200) {
    await insertArticles(
      platform.db,
      ids.slice(i, i + 200).map((id, j) => ({
        id,
        feedId: "feed",
        guid: id,
        title: `タイトル ${id}`,
        summary: null,
        url: options.url ? options.url(i + j) : null,
        author: null,
        publishedAt: new Date(),
        inCurrentFeed: false,
        contentKey: null,
      })),
    );
  }
  // 番号の大きい記事ほど新しい
  const age = options.ageMs ?? 2 * HOUR_MS;
  await testDb.exec(`UPDATE articles SET created_at = cast(unixepoch('subsec') * 1000 as integer) - ${age}
    - (${count - 1} - cast(substr(id, 2) as integer)) WHERE id LIKE '${prefix}%'`);
  return ids;
}

/** 解析済みにする（作るのに手間のかかる状態なので、行を直接入れる） */
async function markAnalyzed(ids: string[]) {
  for (let i = 0; i < ids.length; i += 500) {
    const values = ids
      .slice(i, i + 500)
      .map((id) => `('${id}', 'feed', 1, 'empty', 1, 'empty', 0)`)
      .join(",");
    await testDb.exec(`INSERT INTO article_analyses (article_id, feed_id, candidate_revision,
      candidate_status, embedding_revision, embedding_status, analyzed_at) VALUES ${values}`);
  }
}

const analyzedIds = async () =>
  (
    await testDb.prepare("SELECT article_id FROM article_analyses ORDER BY article_id").all<{
      article_id: string;
    }>()
  ).results.map((row) => row.article_id);

/** 積まれた仕事のうち、指定した種類のものを取り出して動かす */
async function runQueued(platform: Platform, enqueued: Job[], type: Job["type"]) {
  let ran = 0;
  for (
    let job = enqueued.find((j) => j.type === type);
    job;
    job = enqueued.find((j) => j.type === type)
  ) {
    enqueued.splice(enqueued.indexOf(job), 1);
    await runJob(platform, job);
    ran++;
  }
  return ran;
}

beforeEach(async () => {
  await testDb.exec("DELETE FROM feeds");
  await testDb.exec("DELETE FROM article_analysis_backfill");
  await testDb.exec("UPDATE storage_usage SET limit_bytes = 268435456 WHERE id = 1");
});

describe("遡及", () => {
  it("この機能を入れる前の記事を、取り込みの時刻と ID の新しい順に、100 件ずつ引き継いで解析する", async () => {
    const articleAnalysis = fakeArticleAnalysis();
    const { platform, enqueued } = createTestPlatform({ articleAnalysis });
    const ids = await seed(platform, 150);

    await runScheduled(platform, SLOT);
    expect(enqueued.filter((job) => job.type === "backfill-article-analyses")).toEqual([BACKFILL]);
    enqueued.splice(0);
    await runJob(platform, BACKFILL);
    // 1 つ目の仕事は 100 件で止め、区切りを待たずに続きを積む
    expect(articleAnalysis.analyze).toHaveBeenCalledTimes(100);
    expect(enqueued).toEqual([BACKFILL]);
    const order = articleAnalysis.analyze.mock.calls.map(([input]) => input.title);
    expect(order[0]).toBe(`タイトル ${ids[149]}`);
    expect(order[99]).toBe(`タイトル ${ids[50]}`);
    expect((await readBackfill(platform.db))?.cursor?.id).toBe(ids[50]);

    expect(await runQueued(platform, enqueued, "backfill-article-analyses")).toBe(1);
    expect(articleAnalysis.analyze).toHaveBeenCalledTimes(150);
    expect(enqueued).toEqual([]);
    expect(await readBackfill(platform.db)).toMatchObject({ finished: true });
    // 終わったら、定期実行は積まない
    await runScheduled(platform, SLOT);
    expect(enqueued.filter((job) => job.type === "backfill-article-analyses")).toEqual([]);
  });

  it("解析済みの記事は飛ばして 100 件に数えず、たどるのは 1 つの仕事で 1,000 件まで", async () => {
    const articleAnalysis = fakeArticleAnalysis();
    const { platform, enqueued } = createTestPlatform({ articleAnalysis });
    const ids = await seed(platform, 1_150);
    // 新しいほうの 1,050 件は解析済み。残りは古い 100 件
    await markAnalyzed(ids.slice(100));

    await runJob(platform, BACKFILL);
    // 1,000 件をたどっても解析を待つ記事がないので、解析せずに続きを積む
    expect(articleAnalysis.analyze).not.toHaveBeenCalled();
    expect(enqueued).toEqual([BACKFILL]);
    expect((await readBackfill(platform.db))?.cursor?.id).toBe(ids[150]);

    await runQueued(platform, enqueued, "backfill-article-analyses");
    // 飛ばした 50 件は数えず、古い 100 件をちょうど解析して、最後までたどる
    expect(articleAnalysis.analyze).toHaveBeenCalledTimes(100);
    expect(await readBackfill(platform.db)).toMatchObject({ finished: true });
    expect(await analyzedIds()).toHaveLength(1_150);
  });

  it("まだ解析を待たない記事（取り込んでから 1 時間たたず、本文の記録がない URL のある記事）は解析しない", async () => {
    const articleAnalysis = fakeArticleAnalysis();
    const { platform } = createTestPlatform({ articleAnalysis });
    const [young = "", recorded = ""] = await seed(platform, 2, {
      ageMs: 10 * 60 * 1000,
      url: (i) => `https://example.com/${i}`,
    });
    await recordFailedPageContent(platform.db, { articleId: recorded, now: new Date() });
    await runJob(platform, BACKFILL);
    expect(await analyzedIds()).toEqual([recorded]);
    expect(young).not.toBe("");
  });

  it("位置を書く文で、位置が読んだときのままであることを確かめる（先頭に戻したのを古い仕事が上書きしない）", async () => {
    const articleAnalysis = fakeArticleAnalysis();
    const hook = statementHook(
      /update article_analysis_backfill set\s+cursor_created_at = \?/,
      async () => {
        // 古い仕事が位置を書く直前に、1 日 1 回の片付けが先頭に戻す
        await rewindBackfill(platform.db);
      },
    );
    const { platform, enqueued } = createTestPlatform({ db: hook.db, articleAnalysis });
    await seed(platform, 150);
    await runJob(platform, BACKFILL);

    expect(hook.fired()).toBe(true);
    expect(await readBackfill(platform.db)).toMatchObject({ cursor: null, finished: false });
    // 位置を書けなかった仕事は、続きを積まない（定期実行が積む）
    expect(enqueued).toEqual([]);
  });

  it("版を上げたときと、1 日 1 回の片付けのときに、位置が先頭に戻る", async () => {
    const articleAnalysis = fakeArticleAnalysis();
    const { platform, enqueued } = createTestPlatform({ articleAnalysis });
    await seed(platform, 3);
    await runJob(platform, BACKFILL);
    expect(await readBackfill(platform.db)).toMatchObject({ finished: true });

    // 容量で積まれる片付けでは戻さない
    await runJob(platform, { type: "clean-up" });
    expect(await readBackfill(platform.db)).toMatchObject({ finished: true });
    await runDailyCleanUp(platform, enqueued);
    expect(await readBackfill(platform.db)).toMatchObject({ cursor: null, finished: false });
    await runJob(platform, BACKFILL);
    // 解析済みの記事は飛ばすだけ
    expect(articleAnalysis.analyze).toHaveBeenCalledTimes(3);
    expect(await readBackfill(platform.db)).toMatchObject({ finished: true });

    articleAnalysis.candidateRevision = 2;
    await runScheduled(platform, SLOT);
    expect(await readBackfill(platform.db)).toMatchObject({
      cursor: null,
      finished: false,
      candidateRevision: 2,
    });
    await runQueued(platform, enqueued, "backfill-article-analyses");
    expect(articleAnalysis.analyze).toHaveBeenCalledTimes(6);
    expect(articleAnalysis.analyze.mock.calls[5]?.[0]).toMatchObject({
      candidates: true,
      embedding: false,
    });
  });

  it("使用量が 80% を超えるなら後回しにし、位置を進めずに止まり、次はその記事から続ける", async () => {
    const articleAnalysis = fakeArticleAnalysis();
    const { platform, enqueued } = createTestPlatform({ articleAnalysis });
    const ids = await seed(platform, 3);
    const saved =
      (await testDb
        .prepare("SELECT bytes FROM storage_usage WHERE id = 1")
        .first<number>("bytes")) ?? 0;
    onTestFinished(() => testDb.exec(`UPDATE storage_usage SET bytes = ${saved} WHERE id = 1`));
    const total = 256 + 1024 + 128 + 4 + 4;
    platform.retentionConfig = { maxBytes: 10_000 };
    // 1 件目を書いたあとがちょうど 80%（書ける）、2 件目は超える
    await testDb.exec(`UPDATE storage_usage SET bytes = ${8_000 - total} WHERE id = 1`);
    await runJob(platform, BACKFILL);
    expect(await analyzedIds()).toEqual([ids[2]]);
    // 2 件目は、推論の前の確かめで止まる
    expect(articleAnalysis.analyze).toHaveBeenCalledTimes(1);
    expect(await readBackfill(platform.db)).toMatchObject({
      cursor: { id: ids[2] },
      finished: false,
    });
    expect(enqueued).toEqual([]);

    await testDb.exec(`UPDATE storage_usage SET bytes = ${saved} WHERE id = 1`);
    platform.retentionConfig = { maxBytes: 268435456 };
    await runJob(platform, BACKFILL);
    expect((await analyzedIds()).sort()).toEqual([...ids].sort());
    expect(await readBackfill(platform.db)).toMatchObject({ finished: true });
  });

  it("埋め込みの版を上げたあと、その版で初めて最後までたどり終えたら版と時刻を記録し、1 日 1 回の終わりでは書き換えない", async () => {
    const articleAnalysis = fakeArticleAnalysis();
    const { platform, enqueued } = createTestPlatform({ articleAnalysis });
    await seed(platform, 2);
    await runJob(platform, BACKFILL);
    // 機能を入れたときの最初の遡及の終わりでは記録しない（docs/decisions/auto-tagging.md の 6）
    expect(await readBackfill(platform.db)).toMatchObject({
      finished: true,
      completedEmbeddingRevision: 1,
      completedAt: null,
    });

    // 候補の版だけを上げても記録しない
    articleAnalysis.candidateRevision = 2;
    await runJob(platform, BACKFILL);
    expect(await readBackfill(platform.db)).toMatchObject({ finished: true, completedAt: null });

    articleAnalysis.embeddingRevision = 2;
    await runJob(platform, BACKFILL);
    const bumped = await readBackfill(platform.db);
    expect(bumped).toMatchObject({ finished: true, completedEmbeddingRevision: 2 });
    expect(bumped?.completedAt).toEqual(expect.any(Number));

    // 1 日 1 回の遡及の終わりでは書き換えない
    await testDb.exec("UPDATE article_analysis_backfill SET completed_at = 1");
    await runDailyCleanUp(platform, enqueued);
    expect(await readBackfill(platform.db)).toMatchObject({ finished: false });
    await runJob(platform, BACKFILL);
    expect(await readBackfill(platform.db)).toMatchObject({
      finished: true,
      completedEmbeddingRevision: 2,
      completedAt: 1,
    });
  });

  it("埋め込みの版を上げた遡及が 1 日 1 回の巻き戻しをまたいでも、版を続けて上げても、たどり終えたら記録する", async () => {
    const articleAnalysis = fakeArticleAnalysis();
    const { platform, enqueued } = createTestPlatform({ articleAnalysis });
    await seed(platform, 150);
    await runJob(platform, BACKFILL);
    await runQueued(platform, enqueued, "backfill-article-analyses");
    expect(await readBackfill(platform.db)).toMatchObject({ finished: true, completedAt: null });

    articleAnalysis.embeddingRevision = 2;
    await runJob(platform, BACKFILL);
    // 100 件まで進めたところで、1 日 1 回の片付けが先頭に戻す
    expect(await readBackfill(platform.db)).toMatchObject({ finished: false });
    enqueued.splice(0);
    await runDailyCleanUp(platform, enqueued);
    await runJob(platform, BACKFILL);
    await runQueued(platform, enqueued, "backfill-article-analyses");
    expect(await readBackfill(platform.db)).toMatchObject({
      finished: true,
      completedEmbeddingRevision: 2,
      completedAt: expect.any(Number),
    });

    // 版 3 に上げ、途中で版 4 に上げても、たどり終えたら 4 を記録する
    await testDb.exec("UPDATE article_analysis_backfill SET completed_at = 1");
    articleAnalysis.embeddingRevision = 3;
    await runJob(platform, BACKFILL);
    enqueued.splice(0);
    articleAnalysis.embeddingRevision = 4;
    await runJob(platform, BACKFILL);
    await runQueued(platform, enqueued, "backfill-article-analyses");
    const last = await readBackfill(platform.db);
    expect(last).toMatchObject({ finished: true, completedEmbeddingRevision: 4 });
    expect(last?.completedAt).toBeGreaterThan(1);
  });

  it("途中の記事の解析が例外を出しても、その記事を越えて続け、ほかの記事は解析する", async () => {
    const articleAnalysis = fakeArticleAnalysis();
    const hook = statementHook(/from articles a left join page_contents/, async () => {
      throw new Error("database is busy");
    });
    const { platform } = createTestPlatform({ db: hook.db, articleAnalysis });
    const ids = await seed(platform, 3);
    await runJob(platform, BACKFILL);
    expect(hook.fired()).toBe(true);
    // 最初にたどった（いちばん新しい）記事が失敗し、残りの 2 件は解析する
    expect((await analyzedIds()).sort()).toEqual([ids[0], ids[1]].sort());
    expect(await readBackfill(platform.db)).toMatchObject({ finished: true });
  });

  it("取り込みの時刻が同じ記事が仕事の切れ目をまたいでも、重ねず漏らさず解析する", async () => {
    const articleAnalysis = fakeArticleAnalysis();
    const { platform, enqueued } = createTestPlatform({ articleAnalysis });
    const ids = await seed(platform, 150);
    await testDb.exec("UPDATE articles SET created_at = 1700000000000");
    await runJob(platform, BACKFILL);
    await runQueued(platform, enqueued, "backfill-article-analyses");
    expect(articleAnalysis.analyze).toHaveBeenCalledTimes(150);
    expect(await analyzedIds()).toEqual([...ids].sort());
    expect(await readBackfill(platform.db)).toMatchObject({ finished: true });
  });

  it("定期実行は、遡及の仕事がないときだけ積む", async () => {
    const { platform } = createTestPlatform({ articleAnalysis: fakeArticleAnalysis() });
    await seed(platform, 1);
    const calls: { jobs: readonly Job[]; options?: { onlyIfIdle?: boolean } }[] = [];
    platform.jobs.enqueue = async (jobs, options) => {
      calls.push({ jobs, ...(options && { options }) });
    };
    await runScheduled(platform, SLOT);
    expect(
      calls.filter((call) => call.jobs.some((job) => job.type === "backfill-article-analyses")),
    ).toEqual([{ jobs: [BACKFILL], options: { onlyIfIdle: true } }]);
  });
});

describe("拾い直し", () => {
  it("取り込んでから 1 日以内の、解析を待つ記事を、80% を基準にした仕事で拾う", async () => {
    const articleAnalysis = fakeArticleAnalysis();
    const { platform, enqueued } = createTestPlatform({ articleAnalysis });
    // 1 時間たった URL のある記事、本文の記録がある記事、URL のない記事は拾う
    const [hour = ""] = await seed(platform, 1, {
      ageMs: HOUR_MS + 60_000,
      url: () => "https://example.com/hour",
      prefix: "h",
    });
    const [young = "", recorded = ""] = await seed(platform, 2, {
      ageMs: 60_000,
      url: (i) => `https://example.com/young/${i}`,
      prefix: "y",
    });
    await recordFailedPageContent(platform.db, { articleId: recorded, now: new Date() });
    const [noUrl = ""] = await seed(platform, 1, { ageMs: 60_000, prefix: "n" });
    // 1 日より前の記事と、解析済みの記事は拾わない
    await seed(platform, 1, { ageMs: DAY_MS + HOUR_MS, prefix: "o" });
    const [done = ""] = await seed(platform, 1, { ageMs: HOUR_MS * 2, prefix: "d" });
    await markAnalyzed([done]);
    await testDb.exec(
      "INSERT INTO article_analysis_backfill (id, candidate_revision, embedding_revision, finished) VALUES (1, 1, 1, 1)",
    );

    await runScheduled(platform, SLOT);
    const repick = enqueued.filter((job) => job.type === "analyze-articles");
    expect(repick).toHaveLength(1);
    expect(repick[0]).toMatchObject({ background: true });
    expect(
      [...(repick[0]?.type === "analyze-articles" ? repick[0].articleIds : [])].sort(),
    ).toEqual([hour, recorded, noUrl].sort());
    expect(young).not.toBe("");
  });

  it("1 時間と 1 日の境目の前後で、拾うかどうかが分かれる。Discord の投稿は 1 時間を待たずに拾う", async () => {
    const { platform, enqueued } = createTestPlatform({ articleAnalysis: fakeArticleAnalysis() });
    const url = () => "https://example.com/post";
    const [overHour = ""] = await seed(platform, 1, { ageMs: HOUR_MS + 60_000, url, prefix: "p" });
    const [underHour = ""] = await seed(platform, 1, { ageMs: HOUR_MS - 60_000, url, prefix: "q" });
    const [insideDay = ""] = await seed(platform, 1, { ageMs: DAY_MS - 60_000, prefix: "r" });
    const [outsideDay = ""] = await seed(platform, 1, { ageMs: DAY_MS + 60_000, prefix: "s" });
    // Discord のフィードの投稿（URL はある）
    await insertFeed(platform.db, {
      id: "discord",
      url: "https://discord.com/channels/1/2",
      now: new Date(),
    });
    await testDb.exec("UPDATE feeds SET discord_cursor = '0' WHERE id = 'discord'");
    await insertArticles(platform.db, [
      {
        id: "t00000",
        feedId: "discord",
        guid: "t00000",
        title: "投稿",
        summary: null,
        url: "https://discord.com/channels/1/2/3",
        author: null,
        publishedAt: new Date(),
        inCurrentFeed: false,
        contentKey: null,
      },
    ]);
    await testDb.exec(
      "INSERT INTO article_analysis_backfill (id, candidate_revision, embedding_revision, finished) VALUES (1, 1, 1, 1)",
    );

    await runScheduled(platform, SLOT);
    const picked = enqueued.flatMap((job) =>
      job.type === "analyze-articles" ? job.articleIds : [],
    );
    expect([...picked].sort()).toEqual([overHour, insideDay, "t00000"].sort());
    expect(picked).not.toContain(underHour);
    expect(picked).not.toContain(outsideDay);
  });

  it("拾い直しの仕事は、書いたあとの使用量が 80% ちょうどなら書き、超えるなら書かない", async () => {
    const articleAnalysis = fakeArticleAnalysis();
    const { platform } = createTestPlatform({ articleAnalysis });
    const [a = "", b = ""] = await seed(platform, 2);
    const saved =
      (await testDb
        .prepare("SELECT bytes FROM storage_usage WHERE id = 1")
        .first<number>("bytes")) ?? 0;
    onTestFinished(() => testDb.exec(`UPDATE storage_usage SET bytes = ${saved} WHERE id = 1`));
    const total = 256 + 1024 + 128 + 4 + 4;
    platform.retentionConfig = { maxBytes: 10_000 };
    await testDb.exec(`UPDATE storage_usage SET bytes = ${8_000 - total + 1} WHERE id = 1`);
    await runJob(platform, { type: "analyze-articles", articleIds: [a], background: true });
    expect(await analyzedIds()).toEqual([]);
    await testDb.exec(`UPDATE storage_usage SET bytes = ${8_000 - total} WHERE id = 1`);
    await runJob(platform, { type: "analyze-articles", articleIds: [a, b], background: true });
    // 1 件目でちょうど 80% になり、2 件目は超えるので止まる
    expect(await analyzedIds()).toEqual([a]);
  });
});
