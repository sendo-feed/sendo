/**
 * 仕事の運び方（docs/decisions/container.md の 6、docs/decisions/jobs.md）。仕事を SQLite の表（job_queue）に
 * 積み、同じプロセスの中で取り出して動かす。
 *
 * - 取り出すとき：1 つの文で、取り出した回数を増やし、run_at を借りの期限まで先へ送る
 * - 終わったら：行を消す
 * - 失敗したら：MAX_ATTEMPTS 回までは、run_at を少し先へ送ってやり直す。それ以上は諦めて消す
 * - プロセスが途中で落ちたら：借りの期限が過ぎれば、また取り出される。どの仕事も何度実行しても
 *   同じ結果になるので、二重に動いても壊れない
 *
 * jobs/ からは、仕事を 1 つずつ積み、1 つずつ受け取るように見える。
 */
import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  notExists,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { Database } from "../../db";
import { discordConnections, feeds, jobQueue, subscriptions } from "../../db/schema";
import { type Job, jobSchema } from "../../jobs/job";
import { loggableError } from "../../lib/log-error";
import type { JobQueue } from "..";

/** 1 つの仕事を試す回数の上限（docs/decisions/jobs.md の 5） */
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
const discordDueAt = sql`coalesce(${feeds.discordRetryAt}, ${feeds.nextFetchAt})`;

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
  return job.type === "fetch-feed" || job.type === "fetch-discord"
    ? { type: job.type, feedId: job.feedId }
    : { type: job.type };
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
    // Discord の仕事は、同じプロセスで処理が長引いても借り直さない。
    const inFlight = [...active.values()].flatMap((row) => (row.discordFeedId ? [row.id] : []));
    const running = alias(jobQueue, "running");
    const started = db
      .select({ id: running.id })
      .from(running)
      .where(and(eq(running.discordFeedId, jobQueue.discordFeedId), gt(running.attempts, 0)));
    const backingOff = db
      .select({ id: feeds.id })
      .from(feeds)
      .where(
        and(
          eq(feeds.id, jobQueue.discordFeedId),
          isNotNull(feeds.discordConnectionId),
          isNotNull(feeds.lastErrorCode),
          gt(discordDueAt, at.getTime()),
        ),
      );
    // 再試行中の仕事は先に終える。失敗後の待機は、新着で予約した仕事にも効く。
    const discordReady = and(
      or(gt(jobQueue.attempts, 0), notExists(started)),
      notExists(backingOff),
    );
    const due = db
      .select({ id: jobQueue.id })
      .from(jobQueue)
      .where(
        and(
          lte(jobQueue.runAt, at),
          or(isNull(jobQueue.discordFeedId), discordReady),
          inFlight.length > 0 ? notInArray(jobQueue.id, inFlight) : undefined,
        ),
      )
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
        console.error("job failed; giving up", { ...detail, error: loggableError(error) });
        await remove(row.id);
        return;
      }
      console.error("job failed; will retry", { ...detail, error: loggableError(error) });
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
  const active = new Map<Promise<void>, JobRow>();

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
              .catch((error) =>
                console.error("could not settle job", { id: row.id, error: loggableError(error) }),
              )
              .finally(() => {
                active.delete(task);
                notify();
              });
            active.set(task, row);
          }
        } catch (error) {
          console.error("could not claim jobs", loggableError(error));
        }
      }
      // 取り出せるものがなかったか、手がいっぱいなら、知らせを待つ
      if (!stopped && (claimed === 0 || active.size >= concurrency)) await sleep();
    }
  }

  return {
    async enqueueDueDiscordFetches(at, limit) {
      // 定期取得は期限を迎え、仕事がまだない購読に限る。選ぶのと積むのを同じ文で行う。
      const inserted = await db.all<{ id: string }>(sql`
        insert into ${jobQueue} ("id", "job", "discord_feed_id", "run_at")
        select lower(hex(randomblob(16))), json_object('type', 'fetch-discord', 'feedId', ${feeds.id}),
          ${feeds.id}, ${at.getTime()}
        from ${feeds}
        inner join ${discordConnections} on ${feeds.discordConnectionId} = ${discordConnections.id}
        inner join ${subscriptions} on ${subscriptions.feedId} = ${feeds.id}
          and ${subscriptions.userId} = ${discordConnections.userId}
        where ${subscriptions.deletedAt} is null and ${discordDueAt} <= ${at.getTime()}
          and not exists (
            select 1 from ${jobQueue} where ${jobQueue.discordFeedId} = ${feeds.id}
          )
        order by ${discordDueAt}, ${feeds.id}
        limit ${limit}
        on conflict do nothing
        returning id
      `);
      if (inserted.length > 0) notify();
      return inserted.length;
    },
    async enqueue(jobs) {
      const at = now();
      for (let i = 0; i < jobs.length; i += ENQUEUE_CHUNK_SIZE) {
        await db
          .insert(jobQueue)
          .values(
            jobs.slice(i, i + ENQUEUE_CHUNK_SIZE).map((job) => ({
              id: crypto.randomUUID(),
              job: JSON.stringify(job),
              discordFeedId: job.type === "fetch-discord" ? job.feedId : null,
              attempts: 0,
              runAt: at,
            })),
          )
          .onConflictDoNothing()
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
      await Promise.allSettled(active.keys());
    },
  };
}
