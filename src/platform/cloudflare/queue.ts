/**
 * Queues で仕事を運ぶ（docs/decisions/jobs.md）。
 *
 * - 積むとき：仕事を最大 ENVELOPE_MAX_JOBS 個まで「封筒」に詰め、1 つの封筒を 1 つのメッセージにする。
 *   Queues の無料枠は、メッセージごとに操作を数えるため
 * - 受け取るとき：封筒の中の仕事を 1 つずつ、Worker 自身の入口（ctx.exports の JobRunner）で
 *   別の実行として動かす。D1 のクエリと外への取得の上限は実行ごとにあるので、1 つの仕事は
 *   今までどおり、それだけで上限（QUERY_BUDGET）に収めればよい
 *
 * 封筒のことは、ここ（緩衝層の Cloudflare の実装）の中に閉じる。jobs/ からは、仕事を 1 つずつ積み、
 * 1 つずつ受け取るように見える。
 */
import { z } from "zod";
import { type Job, jobSchema } from "../../jobs/job";
import type { JobQueue } from "..";

/** 1 つの封筒に入れる仕事の数の上限（決定の 1）。多いほど、1 つの isolate で使う CPU が増える */
export const ENVELOPE_MAX_JOBS = 10;

/**
 * 1 つの封筒（の JSON）の大きさの上限。Queues は 64KB（1KB は 1,000 バイト）ごとに 1 操作と数え、
 * メッセージには約 100 バイトの内部の情報が付くので、余裕を持って下回らせる。
 * 仕事 1 つでこれを超えるときは、その仕事だけで 1 つの封筒にする（メッセージの上限の 128KB には、
 * インポートの仕事でも収まる）
 */
export const ENVELOPE_MAX_BYTES = 60_000;

/** 1 つの仕事を試す回数の上限（決定の 5）。これだけ失敗したら諦める */
export const MAX_ATTEMPTS = 3;

/** 失敗した仕事を積み直すとき、届くまで置く時間（秒） */
export const RETRY_DELAY_SECONDS = 60;

/**
 * Queues の sendBatch は、1 回に 100 件、合わせて 256KB まで
 * （https://developers.cloudflare.com/queues/platform/limits/）。余裕を持って分ける。
 */
const SEND_BATCH_MAX_MESSAGES = 100;
const SEND_BATCH_MAX_BYTES = 200 * 1024;

/** 封筒に入れた仕事。attempt は、次に動かすのが何回目か（1 から数える） */
export type EnvelopeEntry = { job: Job; attempt: number };
export type Envelope = { jobs: EnvelopeEntry[] };

/**
 * 封筒の形。中の仕事は、受け取ったあとで 1 つずつ jobSchema で確かめる（壊れた仕事が 1 つ
 * あっても、ほかの仕事を捨てないように）。キューの中身は外から書き換えられうる
 */
const envelopeSchema = z.object({
  jobs: z
    .array(z.object({ job: z.unknown(), attempt: z.number().int().min(1) }))
    .min(1)
    .max(ENVELOPE_MAX_JOBS),
});

const encoder = new TextEncoder();
const jsonBytes = (value: unknown) => encoder.encode(JSON.stringify(value)).byteLength;

/** 中身のない封筒の大きさ（{"jobs":[]}） */
const EMPTY_ENVELOPE_BYTES = jsonBytes({ jobs: [] });

/** 仕事を封筒に詰める。数（ENVELOPE_MAX_JOBS）と大きさ（ENVELOPE_MAX_BYTES）を超えないように分ける */
export function packEnvelopes(entries: readonly EnvelopeEntry[]): Envelope[] {
  const envelopes: Envelope[] = [];
  let current: EnvelopeEntry[] = [];
  let bytes = EMPTY_ENVELOPE_BYTES;
  for (const entry of entries) {
    // 区切りのカンマの分を足す
    const size = jsonBytes(entry) + 1;
    const full = current.length >= ENVELOPE_MAX_JOBS || bytes + size > ENVELOPE_MAX_BYTES;
    if (current.length > 0 && full) {
      envelopes.push({ jobs: current });
      current = [];
      bytes = EMPTY_ENVELOPE_BYTES;
    }
    current.push(entry);
    bytes += size;
  }
  if (current.length > 0) envelopes.push({ jobs: current });
  return envelopes;
}

/** 封筒をキューに送る。sendBatch の上限を超えないように分ける */
async function sendEnvelopes(
  queue: Queue,
  envelopes: readonly Envelope[],
  options: { delaySeconds?: number } = {},
): Promise<void> {
  let batch: MessageSendRequest[] = [];
  let bytes = 0;
  const flush = async () => {
    if (batch.length === 0) return;
    await queue.sendBatch(batch);
    batch = [];
    bytes = 0;
  };
  for (const envelope of envelopes) {
    const size = jsonBytes(envelope);
    if (batch.length >= SEND_BATCH_MAX_MESSAGES || bytes + size > SEND_BATCH_MAX_BYTES) {
      await flush();
    }
    batch.push({ body: envelope, contentType: "json", ...options });
    bytes += size;
  }
  await flush();
}

/** 仕事を封筒に詰めて Queues に積む JobQueue */
export function createQueueJobQueue(queue: Queue): JobQueue {
  return {
    async enqueue(jobs) {
      await sendEnvelopes(queue, packEnvelopes(jobs.map((job) => ({ job, attempt: 1 }))));
    },
  };
}

/**
 * 封筒の中の仕事を 1 つ動かすもの。Cloudflare では ctx.exports の JobRunner（src/index.ts）で、
 * 呼ぶたびに別の実行になる。テストでは差し替える
 */
export interface JobRunner {
  run(job: Job): Promise<void>;
}

/**
 * 届いたメッセージを封筒として読む。封筒に入れる前の形（仕事 1 つだけのメッセージ）も、
 * 仕事 1 つの封筒として受ける。封筒に変える前のバージョンが積んだメッセージが、デプロイしたあとに
 * キューに残っていても捨てないため（とくに OPML のインポートは、定期実行では拾い直されない）。
 * 回数は Queues が数えた配送の回数を引き継ぐ
 */
function readEnvelope(message: Message) {
  const bare = jobSchema.safeParse(message.body);
  if (bare.success) {
    return envelopeSchema.safeParse({
      jobs: [{ job: bare.data, attempt: Math.max(1, message.attempts) }],
    });
  }
  return envelopeSchema.safeParse(message.body);
}

/** ログに出す仕事の情報。インポートの URL やユーザーの ID は出さない */
function describeJob(job: Job) {
  return job.type === "fetch-feed" ? { type: job.type, feedId: job.feedId } : { type: job.type };
}

/**
 * キューから届いた封筒の中の仕事を、1 つずつ別の実行で動かす。
 *
 * - 形の正しくない封筒や仕事は、やり直しても直らないので捨てる。封筒に入れる前の形のメッセージは、
 *   仕事 1 つの封筒として動かす（readEnvelope）
 * - 失敗した仕事は、その仕事だけを新しい封筒に入れ、少し間を置いて積み直す。MAX_ATTEMPTS 回
 *   失敗したら諦める。封筒ごとやり直すと、成功したほかの取得までやり直してしまう
 * - 積み直せなかったときは、封筒ごと Queues のやり直しに回す（max_retries まで）。どの仕事も
 *   何度実行しても同じ結果になるので、二重に動いても壊れない
 */
export async function handleQueueBatch(
  batch: MessageBatch,
  runner: JobRunner,
  queue: Queue,
): Promise<void> {
  for (const message of batch.messages) {
    const envelope = readEnvelope(message);
    if (!envelope.success) {
      console.error("dropping invalid envelope", {
        id: message.id,
        issues: envelope.error.issues,
      });
      message.ack();
      continue;
    }

    const entries: EnvelopeEntry[] = [];
    for (const [index, entry] of envelope.data.jobs.entries()) {
      const job = jobSchema.safeParse(entry.job);
      if (!job.success) {
        console.error("dropping invalid job", { id: message.id, index, issues: job.error.issues });
        continue;
      }
      entries.push({ job: job.data, attempt: entry.attempt });
    }

    const results = await Promise.allSettled(entries.map((entry) => runner.run(entry.job)));
    const retries: EnvelopeEntry[] = [];
    results.forEach((result, index) => {
      const entry = entries[index];
      if (result.status === "fulfilled" || entry === undefined) return;
      const detail = { id: message.id, attempt: entry.attempt, ...describeJob(entry.job) };
      if (entry.attempt >= MAX_ATTEMPTS) {
        console.error("job failed; giving up", { ...detail, error: result.reason });
        return;
      }
      console.error("job failed; will retry", { ...detail, error: result.reason });
      retries.push({ job: entry.job, attempt: entry.attempt + 1 });
    });

    try {
      if (retries.length > 0) {
        await sendEnvelopes(queue, packEnvelopes(retries), { delaySeconds: RETRY_DELAY_SECONDS });
      }
      message.ack();
    } catch (error) {
      console.error("could not requeue failed jobs; retrying the envelope", {
        id: message.id,
        attempts: message.attempts,
        error,
      });
      message.retry();
    }
  }
}
