import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

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
});
