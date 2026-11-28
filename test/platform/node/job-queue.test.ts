import { inspect } from "node:util";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jobQueue } from "../../../src/db/schema";
import type { Job } from "../../../src/jobs/job";
import {
  createSqliteJobQueue,
  LEASE_MS,
  MAX_ATTEMPTS,
  RETRY_DELAY_MS,
  type SqliteJobQueue,
} from "../../../src/platform/node/job-queue";
import { openTestDatabase } from "../../db";

const FETCH: Job = { type: "fetch-feed", feedId: "feed-1" };
const CLEAN_UP: Job = { type: "clean-up" };

describe("仕事の表", () => {
  let database: Awaited<ReturnType<typeof openTestDatabase>>;
  let clock: Date;
  let queue: SqliteJobQueue;

  const advance = (ms: number) => {
    clock = new Date(clock.getTime() + ms);
  };
  const rows = () => database.db.select().from(jobQueue).all();

  beforeEach(async () => {
    database = await openTestDatabase();
    clock = new Date("2026-11-16T00:00:00Z");
    queue = createSqliteJobQueue(database.db, { now: () => clock, concurrency: 4 });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await queue.stop();
    await database.cleanup();
  });

  describe("同時に 1 本だけ動かす仕事の枠（記事の解析の遡及。docs/decisions/article-analysis.md の 2）", () => {
    const BACKFILL: Job = { type: "backfill-article-analyses" };

    it("未着手 1 つ・着手済み 1 つまでで、着手済みがあれば未着手を取り出さない", async () => {
      await queue.enqueue([BACKFILL]);
      await queue.enqueue([BACKFILL]);
      expect(await rows()).toHaveLength(1);

      let release: () => void = () => {};
      const running = queue.runDue(async (job) => {
        if (job.type !== "backfill-article-analyses") return;
        // 動いている間に、仕事が自分の続きを積む
        await queue.enqueue([BACKFILL]);
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      });
      await vi.waitFor(async () => expect(await rows()).toHaveLength(2));
      // 着手済みがあるうちは、未着手の続きを取り出さない
      expect(await queue.runDue(async () => {})).toBe(0);
      // 3 つ目は積めない
      await queue.enqueue([BACKFILL]);
      expect(await rows()).toHaveLength(2);
      release();
      expect(await running).toBe(1);
      // 着手済みが終われば、続きを取り出す
      const seen: Job[] = [];
      expect(await queue.runDue(async (job) => void seen.push(job))).toBe(1);
      expect(seen).toEqual([BACKFILL]);
      expect(await rows()).toEqual([]);
    });

    it("onlyIfIdle では、その枠に未着手か着手済みの仕事があれば積まない", async () => {
      await queue.enqueue([BACKFILL], { onlyIfIdle: true });
      expect(await rows()).toHaveLength(1);
      await queue.enqueue([BACKFILL], { onlyIfIdle: true });
      expect(await rows()).toHaveLength(1);

      let release: () => void = () => {};
      const running = queue.runDue(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
      await vi.waitFor(async () => expect((await rows())[0]?.attempts).toBe(1));
      await queue.enqueue([BACKFILL], { onlyIfIdle: true });
      expect(await rows()).toHaveLength(1);
      release();
      await running;
      await queue.enqueue([BACKFILL], { onlyIfIdle: true });
      expect(await rows()).toHaveLength(1);
      await expect(queue.enqueue([CLEAN_UP], { onlyIfIdle: true })).rejects.toThrow("no slot");
    });

    it("unlessWaiting では、その枠に未着手の仕事があれば積まず、着手済みの仕事だけなら積む。枠は人ごとに分かれる", async () => {
      const rejudge = { type: "rejudge-tags", userId: "u1" } as const;
      await queue.enqueue([rejudge], { unlessWaiting: true });
      await queue.enqueue([rejudge], { unlessWaiting: true });
      expect(await rows()).toHaveLength(1);
      // ほかの人の枠は別
      await queue.enqueue([{ type: "rejudge-tags", userId: "u2" }], { unlessWaiting: true });
      expect(await rows()).toHaveLength(2);
      await database.db.run(sql`delete from job_queue where job like '%u2%'`);

      let release: () => void = () => {};
      const running = queue.runDue(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
      await vi.waitFor(async () => expect((await rows())[0]?.attempts).toBe(1));
      // 動いている仕事が続きを積める
      await queue.enqueue([rejudge], { unlessWaiting: true });
      expect(await rows()).toHaveLength(2);
      await queue.enqueue([rejudge], { unlessWaiting: true });
      expect(await rows()).toHaveLength(2);
      // 着手済みがある間は、未着手を取り出さない
      expect(await queue.runDue(async () => {})).toBe(0);
      release();
      await running;
      expect(await rows()).toHaveLength(1);
      await expect(queue.enqueue([CLEAN_UP], { unlessWaiting: true })).rejects.toThrow("no slot");
    });

    it("再起動のあと、借りの期限が切れた着手済みの仕事だけを借り直し、未着手の続きは取り出さない", async () => {
      await queue.enqueue([BACKFILL]);
      // 着手したまま落ちたプロセスの行と、その仕事が積んだ続き
      await database.db.run(sql`update job_queue set attempts = 1`);
      await queue.enqueue([BACKFILL]);
      advance(LEASE_MS + 1);
      const seen: number[] = [];
      const restarted = createSqliteJobQueue(database.db, { now: () => clock, concurrency: 4 });
      const claimed = await restarted.runDue(async () => {
        seen.push((await rows()).filter((row) => row.attempts > 0).length);
      });
      expect(claimed).toBe(1);
      // 動いていたのは着手済みの 1 本だけ
      expect(seen).toEqual([1]);
      expect(await rows()).toHaveLength(1);
      expect((await rows())[0]?.attempts).toBe(0);
    });

    it("枠のない仕事は、枠のある仕事と関係なく取り出す", async () => {
      await queue.enqueue([BACKFILL, FETCH, CLEAN_UP]);
      const seen: string[] = [];
      expect(await queue.runDue(async (job) => void seen.push(job.type))).toBe(3);
      expect(seen.sort()).toEqual(["backfill-article-analyses", "clean-up", "fetch-feed"]);
    });
  });

  it("積んだ仕事を 1 つずつ受け取り、終わったら消す", async () => {
    await queue.enqueue([FETCH, CLEAN_UP]);
    const seen: Job[] = [];
    expect(await queue.runDue(async (job) => void seen.push(job))).toBe(2);
    expect(seen).toEqual(expect.arrayContaining([FETCH, CLEAN_UP]));
    expect(await rows()).toEqual([]);
  });

  it("時刻を指定して積んだ仕事は、その時刻ちょうどから取り出し、1 ミリ秒前には取り出さない", async () => {
    const runAt = new Date(clock.getTime() + 10 * 60 * 1000);
    await queue.enqueue([CLEAN_UP], { runAt });
    const seen: Job[] = [];
    const run = async (job: Job) => void seen.push(job);

    clock = new Date(runAt.getTime() - 1);
    expect(await queue.runDue(run)).toBe(0);
    clock = runAt;
    expect(await queue.runDue(run)).toBe(1);

    expect(seen).toEqual([CLEAN_UP]);
    expect(await rows()).toEqual([]);
  });

  it("同じプロセスで Discord の取得が長引いても、並行して取り出さない", async () => {
    const discord: Job = { type: "fetch-discord", feedId: "channel-1" };
    let release = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const seen: Job[] = [];
    queue.start(async (job) => {
      seen.push(job);
      if (seen.length === 1) await blocked;
    });
    try {
      await queue.enqueue([discord]);
      await vi.waitFor(() => expect(seen).toEqual([discord]));
      advance(LEASE_MS);
      await queue.enqueue([discord, discord, CLEAN_UP]);
      await vi.waitFor(() => expect(seen).toEqual([discord, CLEAN_UP]));
    } finally {
      release();
    }
    await vi.waitFor(() => expect(seen).toEqual([discord, CLEAN_UP, discord]));
  });

  it("失敗した仕事は、少し間を置いてやり直す。上限まで失敗したら諦める", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = vi.fn(async () => {
      throw new Error("boom");
    });
    await queue.enqueue([FETCH]);

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      expect(await queue.runDue(failing)).toBe(1);
      // 間を置くまでは、取り出されない
      expect(await queue.runDue(failing)).toBe(0);
      advance(RETRY_DELAY_MS);
    }
    expect(failing).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    expect(await rows()).toEqual([]);
    expect(errors).toHaveBeenLastCalledWith("job failed; giving up", expect.anything());
  });

  it("仕事の中で文が失敗しても、文に渡した値はログに出さない", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const secret = `secret-${crypto.randomUUID()}`;
    const failing = async () => {
      await database.db.run(sql`insert into no_such_table (value) values (${secret})`);
    };
    await queue.enqueue([FETCH]);

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      expect(await queue.runDue(failing)).toBe(1);
      advance(RETRY_DELAY_MS);
    }

    const logged = inspect(errors.mock.calls, { depth: 10 });
    expect(logged).toContain("job failed; will retry");
    expect(logged).toContain("job failed; giving up");
    // 何の文が、なぜ失敗したかは残す
    expect(logged).toContain("insert into no_such_table");
    expect(logged).toContain("no such table");
    expect(logged).not.toContain(secret);
  });

  it("取り出したまま落ちた仕事は、借りの期限が過ぎたらまた取り出す", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await queue.enqueue([FETCH]);
    // 取り出したところでプロセスが落ちたことにする（行は残り、借りの期限まで先へ送られている）
    const hang = new Promise<void>(() => {});
    void queue.runDue(() => hang);
    await vi.waitFor(async () => expect((await rows())[0]?.attempts).toBe(1));

    const fresh = createSqliteJobQueue(database.db, { now: () => clock });
    const run = vi.fn(async () => {});
    expect(await fresh.runDue(run)).toBe(0);
    advance(LEASE_MS);
    expect(await fresh.runDue(run)).toBe(1);
    expect(run).toHaveBeenCalledWith(FETCH);
    expect(await rows()).toEqual([]);
  });

  it("取り出したまま落ちることが続いた仕事は、上限を超えたら動かさずに消す", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await database.db
      .insert(jobQueue)
      .values({ id: "stuck", job: JSON.stringify(FETCH), attempts: MAX_ATTEMPTS, runAt: clock })
      .run();
    const run = vi.fn(async () => {});
    expect(await queue.runDue(run)).toBe(1);
    expect(run).not.toHaveBeenCalled();
    expect(await rows()).toEqual([]);
  });

  it("形の正しくない仕事は、やり直しても直らないので捨てる", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await database.db
      .insert(jobQueue)
      .values([
        { id: "broken-json", job: "{", attempts: 0, runAt: clock },
        { id: "unknown", job: JSON.stringify({ type: "unknown" }), attempts: 0, runAt: clock },
      ])
      .run();
    const run = vi.fn(async () => {});
    expect(await queue.runDue(run)).toBe(2);
    expect(run).not.toHaveBeenCalled();
    expect(await rows()).toEqual([]);
  });

  it("動かし始めると、積まれた仕事をすぐに受け取る", async () => {
    const seen: Job[] = [];
    queue.start(async (job) => void seen.push(job));
    await queue.enqueue([FETCH]);
    await vi.waitFor(() => expect(seen).toEqual([FETCH]));
    await vi.waitFor(async () => expect(await rows()).toEqual([]));
  });

  it("止めるときは、動いている仕事が終わるのを待つ", async () => {
    let finish: () => void = () => {};
    const done = vi.fn();
    queue.start(
      () =>
        new Promise<void>((resolve) => {
          finish = () => {
            done();
            resolve();
          };
        }),
    );
    await queue.enqueue([FETCH]);
    await vi.waitFor(async () => expect((await rows())[0]?.attempts).toBe(1));

    const stopped = queue.stop();
    finish();
    await stopped;
    expect(done).toHaveBeenCalledOnce();
    expect(await rows()).toEqual([]);
  });
});
