import { drizzle } from "drizzle-orm/d1";
import * as schema from "../../db/schema";
import { type Job, jobSchema } from "../../jobs/job";
import type { JobQueue, Platform } from "..";

/** Cloudflare の env から、アプリが使う Platform を組み立てる */
export function createCloudflarePlatform(env: Env): Platform {
  return {
    db: drizzle(env.DB, { schema }),
    jobs: createQueueJobQueue(env.JOBS),
    fetch: (input, init) => fetch(input, init),
    now: () => new Date(),
    apiToken: env.API_TOKEN || undefined,
  };
}

/**
 * Queues の sendBatch は、1 回に 100 件、合わせて 256KB まで
 * （https://developers.cloudflare.com/queues/platform/limits/）。余裕を持って分ける。
 */
const SEND_BATCH_MAX_MESSAGES = 100;
const SEND_BATCH_MAX_BYTES = 200 * 1024;

export function createQueueJobQueue(queue: Queue): JobQueue {
  return {
    async enqueue(jobs) {
      let batch: Job[] = [];
      let bytes = 0;
      const flush = async () => {
        if (batch.length === 0) return;
        await queue.sendBatch(batch.map((body) => ({ body, contentType: "json" })));
        batch = [];
        bytes = 0;
      };
      for (const job of jobs) {
        const size = new TextEncoder().encode(JSON.stringify(job)).byteLength;
        if (batch.length >= SEND_BATCH_MAX_MESSAGES || bytes + size > SEND_BATCH_MAX_BYTES) {
          await flush();
        }
        batch.push(job);
        bytes += size;
      }
      await flush();
    },
  };
}

/**
 * キューから届いたメッセージを1件ずつ実行する。
 *
 * - 形の正しくないメッセージは、やり直しても直らないので捨てる
 * - 実行中の例外はやり直しに回す。max_retries を超えたら Queues が捨てる
 */
export async function handleQueueBatch(
  batch: MessageBatch,
  run: (job: Job) => Promise<void>,
): Promise<void> {
  for (const message of batch.messages) {
    const parsed = jobSchema.safeParse(message.body);
    if (!parsed.success) {
      console.error("dropping invalid job", { id: message.id, issues: parsed.error.issues });
      message.ack();
      continue;
    }
    try {
      await run(parsed.data);
      message.ack();
    } catch (error) {
      console.error("job failed; will retry", {
        id: message.id,
        attempts: message.attempts,
        error,
      });
      message.retry();
    }
  }
}
