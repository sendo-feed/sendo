import { beforeEach, describe, expect, it } from "vitest";
import { insertArticles } from "../../src/db/articles";
import { readRemovalHorizon } from "../../src/db/retention";
import { unsubscribe } from "../../src/db/subscriptions";
import { runJob } from "../../src/jobs";
import { runCleanUp, SWEEP_BATCH, SWEEP_ROUNDS } from "../../src/jobs/clean-up";
import type { Job } from "../../src/jobs/job";
import { CLEAN_UP_HOUR_UTC, enqueueDailyCleanUp } from "../../src/jobs/schedule";
import { testDb } from "../db";
import { addToInbox, createTestPlatform, requestApp, subscribeFeed, TEST_USER } from "../helpers";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-11-14T00:00:00Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY);

type Platform = ReturnType<typeof createTestPlatform>["platform"];

async function seed(platform: Platform, feedId: string, ids: string[], createdAt: Date) {
  await insertArticles(
    platform.db,
    ids.map((id) => ({
      id,
      feedId,
      guid: id,
      url: null,
      title: id,
      summary: null,
      author: null,
      publishedAt: createdAt,
      createdAt,
    })),
  );
  await addToInbox(
    platform,
    ids.map((articleId) => ({ articleId, feedId, publishedAt: createdAt, receivedAt: createdAt })),
  );
}

const count = async (sql: string) =>
  (await testDb.prepare(sql).first<{ n: number }>())?.n ?? Number.NaN;

beforeEach(async () => {
  await testDb.exec("DELETE FROM feeds");
  await testDb.exec("DELETE FROM user_article_removals");
  await testDb.exec("DELETE FROM removal_horizons");
});

describe("runCleanUp", () => {
  it("空きがあれば古い記事を残し、同期の古い削除記録だけを片付ける", async () => {
    const { platform } = createTestPlatform({ now: () => NOW });
    const feed = await subscribeFeed(platform, {});
    await seed(platform, feed.id, ["old", "young"], daysAgo(120));
    await testDb.exec("UPDATE articles SET created_at = 0 WHERE id = 'old'");
    await testDb
      .prepare("UPDATE articles SET created_at = ? WHERE id = 'young'")
      .bind(daysAgo(10).getTime())
      .run();
    await unsubscribe(platform.db, { userId: TEST_USER.id, feedId: feed.id, now: NOW });
    // 購読をやめると、受信箱の行は消える（消した記録が残る）。消えた時刻を 31 日前にする
    await testDb
      .prepare("UPDATE user_article_removals SET removed_at = ?")
      .bind(daysAgo(31).getTime())
      .run();

    expect(await runCleanUp(platform)).toEqual({
      inbox: 0,
      articles: 0,
      removals: 2,
      settings: 0,
      savedPages: 0,
      bells: 0,
      activity: 0,
      pushRegistrations: 0,
      bellNotifications: 0,
      contents: 0,
      candidates: 0,
    });
    expect(await count("SELECT count(*) AS n FROM articles")).toBe(2);
    expect(await count("SELECT count(*) AS n FROM user_article_removals")).toBe(0);
    expect(await readRemovalHorizon(platform.db, TEST_USER.id)).toBeGreaterThan(0);
  });

  it("キューの仕事として動く", async () => {
    const { platform } = createTestPlatform({ now: () => NOW });

    await expect(runJob(platform, { type: "clean-up" })).resolves.toBeUndefined();
  });
});

describe("通知の行の片付け（docs/decisions/notifications.md の 10）", () => {
  /** 1 つの仕事で消せる通知の行の数 */
  const PER_JOB = SWEEP_ROUNDS.bellNotifications * SWEEP_BATCH;
  const CONTINUATION: Job = { type: "clean-up-bell-notifications" };

  /**
   * ベルを 1 つ付け、作ってから 1 日を過ぎた通知の行を old 行と、作ったばかりの行を 1 行入れる。
   * 何千もの通知の行を取得の仕事で作るのは重いので、行は直接入れる
   */
  async function seedNotifications(platform: Platform, old: number) {
    await testDb.exec("DELETE FROM bell_notifications");
    const feed = await subscribeFeed(platform, {});
    const response = await requestApp(platform, "/api/v1/bells", {
      method: "POST",
      json: { feedId: feed.id },
    });
    expect(response.status).toBe(201);
    const { bell } = (await response.json()) as { bell: { id: string } };
    const now = Date.now();
    await testDb
      .prepare(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
        INSERT INTO bell_notifications (id, user_id, bell_id, article_id, window_start, created_at, state)
        SELECT lower(hex(randomblob(16))), ?, ?, NULL, ? - i, ? - i, 'sent' FROM n`,
      )
      .bind(old, TEST_USER.id, bell.id, now - 2 * DAY, now - 2 * DAY)
      .run();
    await testDb
      .prepare(
        `INSERT INTO bell_notifications (id, user_id, bell_id, article_id, window_start, created_at, state)
        VALUES (lower(hex(randomblob(16))), ?, ?, NULL, ?, ?, 'sent')`,
      )
      .bind(TEST_USER.id, bell.id, now, now)
      .run();
    expect(await rows()).toBe(old + 1);
  }

  const rows = () => count("SELECT count(*) AS n FROM bell_notifications");

  it("消しきれなければ続きの仕事を積み、続きの仕事が残りを消す", async () => {
    const { platform, enqueued } = createTestPlatform();
    await seedNotifications(platform, 2 * PER_JOB + 1);

    await runJob(platform, { type: "clean-up" });
    expect(await rows()).toBe(PER_JOB + 2);
    expect(enqueued).toEqual([CONTINUATION]);

    // 仕事の表と同じく、積まれた仕事を 1 つずつ動かす
    let runs = 0;
    for (let job = enqueued.shift(); job; job = enqueued.shift()) {
      if (++runs > 10) throw new Error("jobs kept coming");
      await runJob(platform, job);
    }
    expect(runs).toBe(2);
    // 作ってから 1 日たっていない行は残る
    expect(await rows()).toBe(1);
  });

  it("最後の文がちょうど満杯なら続きを積み、消すもののなかった続きの仕事は積まない", async () => {
    const { platform, enqueued } = createTestPlatform();
    await seedNotifications(platform, PER_JOB);

    await runJob(platform, { type: "clean-up" });
    expect(await rows()).toBe(1);
    expect(enqueued).toEqual([CONTINUATION]);

    enqueued.length = 0;
    await runJob(platform, CONTINUATION);
    expect(enqueued).toEqual([]);
    expect(await rows()).toBe(1);
  });

  it("最後の文が満杯でなければ、続きを積まない", async () => {
    const { platform, enqueued } = createTestPlatform();
    await seedNotifications(platform, PER_JOB - 1);

    await runJob(platform, { type: "clean-up" });
    expect(await rows()).toBe(1);
    expect(enqueued).toEqual([]);
  });

  it("続きを積めずに落ちても、やり直した片付けが残りを消す", async () => {
    const { platform, enqueued } = createTestPlatform();
    await seedNotifications(platform, PER_JOB + 1);
    const failing = {
      ...platform,
      jobs: {
        ...platform.jobs,
        async enqueue() {
          throw new Error("could not enqueue");
        },
      },
    };

    await expect(runJob(failing, { type: "clean-up" })).rejects.toThrow("could not enqueue");
    expect(await rows()).toBe(2);

    // 仕事の表が、落ちた片付けをやり直す
    await runJob(platform, { type: "clean-up" });
    expect(await rows()).toBe(1);
    expect(enqueued).toEqual([]);
  });
});

describe("enqueueDailyCleanUp", () => {
  it("片付けの時刻の最初の定期実行でだけ、片付けの仕事を積む", async () => {
    const { platform, enqueued } = createTestPlatform();
    const at = (hour: number, minute: number) => new Date(Date.UTC(2026, 10, 14, hour, minute));

    expect(await enqueueDailyCleanUp(platform, at(CLEAN_UP_HOUR_UTC, 0))).toBe(true);
    expect(await enqueueDailyCleanUp(platform, at(CLEAN_UP_HOUR_UTC, 5))).toBe(false);
    expect(await enqueueDailyCleanUp(platform, at(CLEAN_UP_HOUR_UTC, 10))).toBe(false);
    expect(await enqueueDailyCleanUp(platform, at(CLEAN_UP_HOUR_UTC - 1, 0))).toBe(false);
    expect(enqueued).toEqual([{ type: "clean-up" }]);
  });
});
