/**
 * コンテナ版の仕事の運び方（docs/decisions/container.md の 6）。仕事を SQLite の表（job_queue）に
 * 積み、同じプロセスの中で取り出して動かす。
 *
 * - 取り出すとき：1 つの文で、取り出した回数を増やし、run_at を借りの期限まで先へ送る
 * - 終わったら：行を消す
 * - 失敗したら：MAX_ATTEMPTS 回までは、run_at を少し先へ送ってやり直す。それ以上は諦めて消す
 * - プロセスが途中で落ちたら：借りの期限が過ぎれば、また取り出される。どの仕事も何度実行しても
 *   同じ結果になるので、二重に動いても壊れない
 *
 * jobs/ からは、Cloudflare 版と同じく、仕事を 1 つずつ積み、1 つずつ受け取るように見える。
 */
import { asc, eq, inArray, lte, sql } from "drizzle-orm";
import type { Database } from "../../db";
import { jobQueue } from "../../db/schema";
import { type Job, jobSchema } from "../../jobs/job";
import type { JobQueue } from "..";

/** 1 つの仕事を試す回数の上限。Cloudflare 版（platform/cloudflare/queue.ts）と同じ */
export const MAX_ATTEMPTS = 3;

/** 失敗した仕事を、やり直すまで置く時間 */
export const RETRY_DELAY_MS = 60 * 1000;

/**
 * 取り出してから、終わるまでの猶予。これを過ぎても終わらなければ（プロセスが落ちたなど）、
 * また取り出される。フィードの取得の借り（jobs/schedule.ts）と同じ長さにする
 */
export const LEASE_MS = 15 * 60 * 1000;

/** 同時に動かす仕事の数。取得の仕事はほとんど相手の応答を待っているので、少し重ねる */
export const DEFAULT_CONCURRENCY = 4;

/** 積まれた知らせがなくても、表を見に行く間隔（やり直しの時期が来た仕事を拾う） */
const POLL_INTERVAL_MS = 5 * 1000;

/** 1 つの文で積む仕事の数 */
const ENQUEUE_CHUNK_SIZE = 100;

export type JobRunner = (job: Job) => Promise<void>;

export interface SqliteJobQueue extends JobQueue {
  /** 仕事を取り出して動かし始める */
  start(run: JobRunner): void;
  /** 取り出すのをやめ、動いている仕事が終わるのを待つ */
  stop(): Promise<void>;
  /**
   * 時期の来た仕事を、limit 個まで取り出して動かし、終わるのを待つ。動かした数を返す。
   * start の中でも使う。テストでは、これを直接呼ぶ
   */
  runDue(run: JobRunner, limit?: number): Promise<number>;
}

type JobRow = typeof jobQueue.$inferSelect;

/** ログに出す仕事の情報。インポートの URL やユーザーの ID は出さない */
function describeJob(job: Job) {
  return job.type === "fetch-feed" ? { type: job.type, feedId: job.feedId } : { type: job.type };
}

export function createSqliteJobQueue(
  db: Database,
  options: { now?: () => Date; concurrency?: number } = {},
): SqliteJobQueue {
  const now = options.now ?? (() => new Date());
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;

  // 知らせ。待っている間に来たら起こし、待っていない間（表を見ている最中など）に来たら覚えておく
  let wake: (() => void) | undefined;
  let pending = false;
  const notify = () => {
    if (wake === undefined) {
      pending = true;
      return;
    }
    wake();
    wake = undefined;
  };

  /** 時期の来た仕事を取り出す。取り出した回数を増やし、借りの期限まで先へ送る */
  async function claim(limit: number): Promise<JobRow[]> {
    const at = now();
    const due = db
      .select({ id: jobQueue.id })
      .from(jobQueue)
      .where(lte(jobQueue.runAt, at))
      .orderBy(asc(jobQueue.runAt))
      .limit(limit);
    return db
      .update(jobQueue)
      .set({
        attempts: sql`${jobQueue.attempts} + 1`,
        runAt: new Date(at.getTime() + LEASE_MS),
      })
      .where(inArray(jobQueue.id, due))
      .returning()
      .all();
  }

  async function remove(id: string): Promise<void> {
    await db.delete(jobQueue).where(eq(jobQueue.id, id)).run();
  }

  /** 取り出した仕事を 1 つ動かし、結果に合わせて行を消すか、やり直しに回す */
  async function process(row: JobRow, run: JobRunner): Promise<void> {
    let value: unknown;
    try {
      value = JSON.parse(row.job);
    } catch {
      value = undefined;
    }
    const parsed = jobSchema.safeParse(value);
    if (!parsed.success) {
      console.error("dropping invalid job", { id: row.id, issues: parsed.error?.issues });
      await remove(row.id);
      return;
    }
    const job = parsed.data;
    const detail = { id: row.id, attempt: row.attempts, ...describeJob(job) };
    // 取り出したまま落ちることが続いた仕事（取り出した回数が上限を超えた）は、もう動かさない
    if (row.attempts > MAX_ATTEMPTS) {
      console.error("job kept failing; giving up", detail);
      await remove(row.id);
      return;
    }

    try {
      await run(job);
    } catch (error) {
      if (row.attempts >= MAX_ATTEMPTS) {
        console.error("job failed; giving up", { ...detail, error });
        await remove(row.id);
        return;
      }
      console.error("job failed; will retry", { ...detail, error });
      // 行の ID と、取り出した回数で絞る。借りの期限が過ぎて取り出し直された行は動かさない
      await db
        .update(jobQueue)
        .set({ runAt: new Date(now().getTime() + RETRY_DELAY_MS) })
        .where(sql`${jobQueue.id} = ${row.id} and ${jobQueue.attempts} = ${row.attempts}`)
        .run();
      return;
    }
    await remove(row.id);
  }

  async function runDue(run: JobRunner, limit = concurrency): Promise<number> {
    const rows = await claim(limit);
    await Promise.all(rows.map((row) => process(row, run)));
    return rows.length;
  }

  let stopped = true;
  let loop: Promise<void> | undefined;
  const active = new Set<Promise<void>>();

  /** 知らせが来るか、間隔が過ぎるまで待つ */
  const sleep = () =>
    new Promise<void>((resolve) => {
      if (pending) {
        pending = false;
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        wake = undefined;
        resolve();
      }, POLL_INTERVAL_MS);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });

  async function runLoop(run: JobRunner): Promise<void> {
    while (!stopped) {
      const free = concurrency - active.size;
      let claimed = 0;
      if (free > 0) {
        // ここから先に来た知らせは、取り出したあとに見落とさないように覚えておく
        pending = false;
        try {
          const rows = await claim(free);
          claimed = rows.length;
          for (const row of rows) {
            const task: Promise<void> = process(row, run)
              .catch((error) => console.error("could not settle job", { id: row.id, error }))
              .finally(() => {
                active.delete(task);
                notify();
              });
            active.add(task);
          }
        } catch (error) {
          console.error("could not claim jobs", error);
        }
      }
      // 取り出せるものがなかったか、手がいっぱいなら、知らせを待つ
      if (!stopped && (claimed === 0 || active.size >= concurrency)) await sleep();
    }
  }

  return {
    async enqueue(jobs) {
      const at = now();
      for (let i = 0; i < jobs.length; i += ENQUEUE_CHUNK_SIZE) {
        await db
          .insert(jobQueue)
          .values(
            jobs.slice(i, i + ENQUEUE_CHUNK_SIZE).map((job) => ({
              id: crypto.randomUUID(),
              job: JSON.stringify(job),
              attempts: 0,
              runAt: at,
            })),
          )
          .run();
      }
      notify();
    },
    runDue,
    start(run) {
      if (!stopped) return;
      stopped = false;
      loop = runLoop(run);
    },
    async stop() {
      stopped = true;
      notify();
      await loop;
      await Promise.allSettled([...active]);
    },
  };
}
