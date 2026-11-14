import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { handleQueueBatch } from "../src/platform/cloudflare";

describe("Worker", () => {
  it("GET /healthz は ok を返す", async () => {
    const res = await exports.default.fetch("https://sendo.test/healthz");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("存在しないパスは JSON の 404 を返す", async () => {
    const res = await exports.default.fetch("https://sendo.test/no-such-path");

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "not_found", message: "Not Found" } });
  });

  it("API は env の API_TOKEN で認証する", async () => {
    const res = await exports.default.fetch("https://sendo.test/api/v1/feeds", {
      headers: { authorization: "Bearer test-token" },
    });

    expect(res.status).toBe(200);
  });
});

describe("handleQueueBatch", () => {
  it("正しい仕事は実行して ack、失敗したら retry、形の正しくないものは捨てる", async () => {
    const batch = createMessageBatch("sendo-jobs", [
      { id: "ok", timestamp: new Date(), attempts: 1, body: { type: "fetch-feed", feedId: "f1" } },
      {
        id: "boom",
        timestamp: new Date(),
        attempts: 1,
        body: { type: "fetch-feed", feedId: "f2" },
      },
      { id: "bad", timestamp: new Date(), attempts: 1, body: { type: "unknown" } },
    ]);
    const ran: string[] = [];

    await handleQueueBatch(batch, async (job) => {
      ran.push(job.feedId);
      if (job.feedId === "f2") throw new Error("boom");
    });

    const result = await getQueueResult(batch, createExecutionContext());
    expect(ran).toEqual(["f1", "f2"]);
    expect(result.explicitAcks.sort()).toEqual(["bad", "ok"]);
    expect(result.retryMessages.map((message) => message.msgId)).toEqual(["boom"]);
  });
});
