import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { Job } from "../../src/jobs/job";
import {
  createQueueJobQueue,
  ENVELOPE_MAX_BYTES,
  ENVELOPE_MAX_JOBS,
  type EnvelopeEntry,
  handleQueueBatch,
  MAX_ATTEMPTS,
  packEnvelopes,
  RETRY_DELAY_SECONDS,
} from "../../src/platform/cloudflare/queue";

const fetchJob = (feedId: string): Job => ({ type: "fetch-feed", feedId });
const entry = (job: Job, attempt = 1): EnvelopeEntry => ({ job, attempt });
const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

/** 送ったメッセージを覚えておく、差し替えのキュー */
function fakeQueue(options: { fail?: boolean } = {}) {
  const batches: MessageSendRequest[][] = [];
  const queue = {
    async send() {
      throw new Error("use sendBatch");
    },
    async sendBatch(messages: Iterable<MessageSendRequest>) {
      if (options.fail) throw new Error("queue is down");
      batches.push([...messages]);
    },
  } as unknown as Queue;
  return { queue, batches, sent: () => batches.flat() };
}

describe("packEnvelopes", () => {
  it("仕事を、1 つの封筒に ENVELOPE_MAX_JOBS 個までずつ詰める", () => {
    const jobs = Array.from({ length: 25 }, (_, i) => entry(fetchJob(`f${i}`)));

    const envelopes = packEnvelopes(jobs);

    expect(envelopes.map((envelope) => envelope.jobs.length)).toEqual([
      ENVELOPE_MAX_JOBS,
      ENVELOPE_MAX_JOBS,
      5,
    ]);
    expect(envelopes.flatMap((envelope) => envelope.jobs)).toEqual(jobs);
  });

  it("大きな仕事は、封筒が ENVELOPE_MAX_BYTES を超えないように分ける", () => {
    // インポートの仕事は、長い URL を 10 件持つと 20KB を超える
    const importJob = (n: number): Job => ({
      type: "import-feeds",
      userId: "user",
      feeds: Array.from({ length: 10 }, (_, i) => ({
        url: `https://example.com/${n}/${i}/${"x".repeat(2000)}`,
        folder: null,
      })),
    });
    const jobs = Array.from({ length: 5 }, (_, n) => entry(importJob(n)));

    const envelopes = packEnvelopes(jobs);

    expect(envelopes.length).toBeGreaterThan(1);
    expect(envelopes.flatMap((envelope) => envelope.jobs)).toEqual(jobs);
    for (const envelope of envelopes) {
      expect(jsonBytes(envelope)).toBeLessThanOrEqual(ENVELOPE_MAX_BYTES);
    }
  });

  it("1 つで上限を超える仕事は、その仕事だけで封筒にする", () => {
    const huge = entry({
      type: "import-feeds",
      userId: "user",
      feeds: [{ url: `https://example.com/${"x".repeat(ENVELOPE_MAX_BYTES)}`, folder: null }],
    });

    const envelopes = packEnvelopes([entry(fetchJob("a")), huge, entry(fetchJob("b"))]);

    expect(envelopes.map((envelope) => envelope.jobs.length)).toEqual([1, 1, 1]);
  });
});

describe("createQueueJobQueue", () => {
  it("仕事を封筒に詰めて送る。どれも 1 回目として積む", async () => {
    const { queue, batches, sent } = fakeQueue();
    const jobs = Array.from({ length: 25 }, (_, i) => fetchJob(`f${i}`));

    await createQueueJobQueue(queue).enqueue(jobs);

    expect(batches).toHaveLength(1);
    expect(sent().map((message) => message.body)).toEqual(
      packEnvelopes(jobs.map((job) => entry(job))),
    );
    expect(sent().every((message) => message.delaySeconds === undefined)).toBe(true);
  });

  it("sendBatch には、1 回に 100 件までずつ送る", async () => {
    const { queue, batches } = fakeQueue();
    const jobs = Array.from({ length: 150 * ENVELOPE_MAX_JOBS }, (_, i) => fetchJob(`f${i}`));

    await createQueueJobQueue(queue).enqueue(jobs);

    expect(batches.map((batch) => batch.length)).toEqual([100, 50]);
  });
});

describe("handleQueueBatch", () => {
  const message = (id: string, body: unknown) => ({
    id,
    timestamp: new Date(),
    attempts: 1,
    body,
  });

  it("封筒の仕事を 1 つずつ動かし、失敗した仕事だけを、回数を進めて間を置いて積み直す", async () => {
    const { queue, sent } = fakeQueue();
    const batch = createMessageBatch("sendo-jobs", [
      message("m1", {
        jobs: [
          entry(fetchJob("ok")),
          entry(fetchJob("boom")),
          entry(fetchJob("last"), MAX_ATTEMPTS),
          { job: { type: "unknown" }, attempt: 1 },
        ],
      }),
    ]);
    const ran: string[] = [];
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    await handleQueueBatch(
      batch,
      {
        async run(job) {
          if (job.type !== "fetch-feed") throw new Error(`unexpected job: ${job.type}`);
          ran.push(job.feedId);
          if (job.feedId !== "ok") throw new Error("boom");
        },
      },
      queue,
    );

    const result = await getQueueResult(batch, createExecutionContext());
    expect(ran.sort()).toEqual(["boom", "last", "ok"]);
    // 形の正しくない仕事は捨て、試す回数の上限に来た仕事は諦める
    expect(sent()).toEqual([
      {
        body: { jobs: [entry(fetchJob("boom"), 2)] },
        contentType: "json",
        delaySeconds: RETRY_DELAY_SECONDS,
      },
    ]);
    expect(result.explicitAcks).toEqual(["m1"]);
    expect(result.retryMessages).toEqual([]);
    errors.mockRestore();
  });

  it("形の正しくない封筒は、動かさずに捨てる", async () => {
    const { queue, sent } = fakeQueue();
    const batch = createMessageBatch("sendo-jobs", [
      message("not-a-job", { type: "unknown" }),
      message("empty", { jobs: [] }),
      message("too-many", {
        jobs: Array.from({ length: ENVELOPE_MAX_JOBS + 1 }, (_, i) => entry(fetchJob(`f${i}`))),
      }),
    ]);
    const run = vi.fn(async () => {});
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    await handleQueueBatch(batch, { run }, queue);

    const result = await getQueueResult(batch, createExecutionContext());
    expect(run).not.toHaveBeenCalled();
    expect(sent()).toEqual([]);
    expect(result.explicitAcks.sort()).toEqual(["empty", "not-a-job", "too-many"]);
    errors.mockRestore();
  });

  it("封筒に入れる前の形のメッセージも、仕事 1 つとして動かす。回数は配送の回数を引き継ぐ", async () => {
    const { queue, sent } = fakeQueue();
    const batch = createMessageBatch("sendo-jobs", [
      { ...message("ok", fetchJob("ok")), attempts: 1 },
      { ...message("boom", fetchJob("boom")), attempts: 2 },
    ]);
    const ran: string[] = [];
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    await handleQueueBatch(
      batch,
      {
        async run(job) {
          if (job.type !== "fetch-feed") throw new Error(`unexpected job: ${job.type}`);
          ran.push(job.feedId);
          if (job.feedId === "boom") throw new Error("boom");
        },
      },
      queue,
    );

    const result = await getQueueResult(batch, createExecutionContext());
    expect(ran).toEqual(["ok", "boom"]);
    expect(sent().map((sentMessage) => sentMessage.body)).toEqual([
      { jobs: [entry(fetchJob("boom"), 3)] },
    ]);
    expect(result.explicitAcks.sort()).toEqual(["boom", "ok"]);
    errors.mockRestore();
  });

  it("積み直せなかったら、封筒ごと Queues のやり直しに回す", async () => {
    const { queue } = fakeQueue({ fail: true });
    const batch = createMessageBatch("sendo-jobs", [
      message("m1", { jobs: [entry(fetchJob("ok")), entry(fetchJob("boom"))] }),
    ]);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    await handleQueueBatch(
      batch,
      {
        async run(job) {
          if (job.type === "fetch-feed" && job.feedId === "boom") throw new Error("boom");
        },
      },
      queue,
    );

    const result = await getQueueResult(batch, createExecutionContext());
    expect(result.explicitAcks).toEqual([]);
    expect(result.retryMessages.map((retry) => retry.msgId)).toEqual(["m1"]);
    errors.mockRestore();
  });
});
