import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jobQueue } from "../../src/db/schema";
import type { Job } from "../../src/jobs/job";
import {
  createSqliteJobQueue,
  LEASE_MS,
  MAX_ATTEMPTS,
  RETRY_DELAY_MS,
  type SqliteJobQueue,
} from "../../src/platform/node/job-queue";
import { openTestDatabase } from "./helpers";

const FETCH: Job = { type: "fetch-feed", feedId: "feed-1" };
const CLEAN_UP: Job = { type: "clean-up" };

describe("コンテナ版の仕事の表", () => {
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

  it("積んだ仕事を 1 つずつ受け取り、終わったら消す", async () => {
    await queue.enqueue([FETCH, CLEAN_UP]);
    const seen: Job[] = [];
    expect(await queue.runDue(async (job) => void seen.push(job))).toBe(2);
    expect(seen).toEqual(expect.arrayContaining([FETCH, CLEAN_UP]));
    expect(await rows()).toEqual([]);
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
