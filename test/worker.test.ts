import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Job } from "../src/jobs/job";
import { TEST_TOKEN } from "./fixtures/user";

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

  it("API は D1 のアクセストークンで認証する", async () => {
    const res = await exports.default.fetch("https://sendo.test/api/v1/feeds", {
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });

    expect(res.status).toBe(200);
  });
});

describe("JobRunner", () => {
  it("ctx.exports から、キューの仕事を 1 つ動かせる", async () => {
    // フィードがなければ、取得は何もせずに終わる
    await expect(
      exports.JobRunner.run({ type: "fetch-feed", feedId: "no-such-feed" }),
    ).resolves.toBeUndefined();
  });

  it("形の正しくない仕事は動かさない", async () => {
    const error = await exports.JobRunner.run({ type: "unknown" } as unknown as Job).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(Error);
  });
});
