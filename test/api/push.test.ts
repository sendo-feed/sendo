import { describe, expect, it, vi } from "vitest";
import { base64UrlDecode } from "../../src/lib/crypto";
import type { Platform } from "../../src/platform";
import { createNodePlatform, type NodeEnv } from "../../src/platform/node";
import { createSqliteJobQueue } from "../../src/platform/node/job-queue";
import { testDatabase, testDb } from "../db";
import {
  createSessionHeaders,
  requestApp,
  TEST_USER,
  unusedNative,
  unusedSyncUpdates,
} from "../helpers";

const PUSH_ENV = {
  VAPID_SUBJECT: "mailto:admin@example.com",
  READER_URL: "https://reader.example.com",
};

/** 本番の組み立て（src/platform/node/main.ts と同じ）で、環境変数から Platform を作る */
function platformFor(env: NodeEnv, overrides: { fetch?: typeof fetch } = {}): Platform {
  return createNodePlatform({
    env: { DATA_DIR: testDatabase.directory, ...env },
    db: testDatabase.db,
    jobs: createSqliteJobQueue(testDatabase.db),
    syncUpdates: unusedSyncUpdates,
    fetch: async () => {
      throw new Error("network access is not allowed in tests");
    },
    ...unusedNative,
    ...overrides,
  });
}

type PushStatus = { available: boolean; publicKey: string | null };

async function readStatus(platform: Platform, headers: Record<string, string>) {
  const res = await requestApp(platform, "/api/v1/push", { token: null, headers });
  expect(res.status).toBe(200);
  return (await res.json()) as PushStatus;
}

describe("Web Push の有無と公開鍵", () => {
  it("VAPID_SUBJECT と READER_URL があれば、使えると返す。公開鍵は P-256 の非圧縮の点で、何度呼んでも同じ", async () => {
    const headers = await createSessionHeaders(TEST_USER.id);
    for (const subject of ["mailto:admin@example.com", "https://sendo.example.com/contact"]) {
      const env = { ...PUSH_ENV, VAPID_SUBJECT: subject };
      const status = await readStatus(platformFor(env), headers);

      expect(status.available, subject).toBe(true);
      const point = base64UrlDecode(status.publicKey ?? "");
      expect(point?.length).toBe(65);
      expect(point?.[0]).toBe(0x04);
      await expect(
        crypto.subtle.importKey(
          "raw",
          point ?? new Uint8Array(),
          { name: "ECDSA", namedCurve: "P-256" },
          true,
          ["verify"],
        ),
      ).resolves.toBeDefined();
      // 組み立て直した（起動し直した）sendo でも、同じ鍵を返す
      expect(await readStatus(platformFor(env), headers)).toEqual(status);
    }
  });

  it("鍵のない sendo に同時に聞いても、鍵は 1 つ", async () => {
    await testDb.exec("DELETE FROM app_secrets WHERE name = 'vapid_key'");
    const headers = await createSessionHeaders(TEST_USER.id);
    const platform = platformFor(PUSH_ENV);

    const [first, second] = await Promise.all([
      readStatus(platform, headers),
      readStatus(platform, headers),
    ]);

    expect(first.publicKey).not.toBeNull();
    expect(second).toEqual(first);
    expect(await readStatus(platformFor(PUSH_ENV), headers)).toEqual(first);
  });

  it("どちらかがない、または形が正しくなければ、使えないと返す。形の誤りはログに出す", async () => {
    const headers = await createSessionHeaders(TEST_USER.id);
    const cases: { env: NodeEnv; logged: boolean }[] = [
      { env: {}, logged: false },
      { env: { VAPID_SUBJECT: PUSH_ENV.VAPID_SUBJECT }, logged: false },
      { env: { READER_URL: PUSH_ENV.READER_URL }, logged: false },
      { env: { ...PUSH_ENV, VAPID_SUBJECT: " " }, logged: false },
      { env: { ...PUSH_ENV, VAPID_SUBJECT: "admin@example.com" }, logged: true },
      { env: { ...PUSH_ENV, VAPID_SUBJECT: "mailto:" }, logged: true },
      { env: { ...PUSH_ENV, VAPID_SUBJECT: "http://sendo.example.com/" }, logged: true },
      { env: { ...PUSH_ENV, READER_URL: "http://reader.example.com" }, logged: true },
      { env: { ...PUSH_ENV, READER_URL: "https://reader.example.com/app" }, logged: true },
    ];
    for (const { env, logged } of cases) {
      const label = JSON.stringify(env);
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const platform = platformFor(env);
        // READER_URL の誤りは、OAuth と Discord の設定もログに出す。Web Push の分だけを数える
        const pushErrors = errors.mock.calls.filter(([message]) =>
          String(message).startsWith("Web Push is disabled"),
        );
        expect(pushErrors.length > 0, label).toBe(logged);

        expect(await readStatus(platform, headers), label).toEqual({
          available: false,
          publicKey: null,
        });
      } finally {
        errors.mockRestore();
      }
    }
  });

  it("アクセストークンでは使えない（403 session_required）", async () => {
    const res = await requestApp(platformFor(PUSH_ENV), "/api/v1/push");

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: "session_required" } });
  });
});
