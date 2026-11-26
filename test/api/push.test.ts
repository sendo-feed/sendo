import { describe, expect, it, vi } from "vitest";
import type { Database } from "../../src/db";
import { createSession } from "../../src/db/sessions";
import { runCleanUp } from "../../src/jobs/clean-up";
import { base64UrlDecode, base64UrlEncode } from "../../src/lib/crypto";
import type { Platform } from "../../src/platform";
import { createNodePlatform, type NodeEnv } from "../../src/platform/node";
import { createSqliteJobQueue } from "../../src/platform/node/job-queue";
import { testDatabase, testDb } from "../db";
import { createFakeGoogle, GOOGLE_CLIENT, type Jar, login, send } from "../google-login";
import {
  createSessionHeaders,
  createUser,
  requestApp,
  statementHook,
  TEST_USER,
  unusedNative,
  unusedSyncUpdates,
} from "../helpers";

const PUSH_ENV = {
  VAPID_SUBJECT: "mailto:admin@example.com",
  READER_URL: "https://reader.example.com",
};

/** 本番の組み立て（src/platform/node/main.ts と同じ）で、環境変数から Platform を作る */
function platformFor(
  env: NodeEnv,
  overrides: { fetch?: typeof fetch; db?: Database } = {},
): Platform {
  return createNodePlatform({
    env: { DATA_DIR: testDatabase.directory, ...env },
    db: overrides.db ?? testDatabase.db,
    jobs: createSqliteJobQueue(testDatabase.db),
    syncUpdates: unusedSyncUpdates,
    fetch:
      overrides.fetch ??
      (async () => {
        throw new Error("network access is not allowed in tests");
      }),
    ...unusedNative,
  });
}

type PushStatus = { available: boolean; publicKey: string | null };

async function readStatus(platform: Platform, headers: Record<string, string>) {
  const res = await requestApp(platform, "/api/v1/push", { token: null, headers });
  expect(res.status).toBe(200);
  return (await res.json()) as PushStatus;
}

/** ブラウザのセッションを作る。Google のログインを通さずに、セッションで認証した API を試すのに使う */
async function sessionFor(userId: string) {
  const { token, session } = await createSession(testDatabase.db, { userId, now: new Date() });
  return {
    sessionId: session.id,
    headers: { cookie: `__Host-sendo_session=${token}`, "sec-fetch-site": "same-origin" },
  };
}

/** 端末の鍵（本物の P-256 の公開鍵と、16 バイトの auth） */
async function deviceKeys() {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ]);
  const point = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return {
    p256dh: base64UrlEncode(point),
    auth: base64UrlEncode(crypto.getRandomValues(new Uint8Array(16))),
  };
}

const newEndpoint = () => `https://push.example.com/send/${crypto.randomUUID()}`;

/** ブラウザの PushSubscription.toJSON() と同じ形 */
async function subscription(endpoint = newEndpoint()) {
  return { endpoint, expirationTime: null, keys: await deviceKeys() };
}

type Subscription = Awaited<ReturnType<typeof subscription>>;

const register = (platform: Platform, headers: Record<string, string>, body: unknown) =>
  requestApp(platform, "/api/v1/push/registration", {
    method: "PUT",
    token: null,
    headers,
    json: body,
  });

const unregister = (platform: Platform, headers: Record<string, string>) =>
  requestApp(platform, "/api/v1/push/registration", { method: "DELETE", token: null, headers });

type RegistrationRow = {
  id: string;
  user_id: string;
  session_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
};

async function registrations(where: string, value: string) {
  const { results } = await testDb
    .prepare(
      `SELECT id, user_id, session_id, endpoint, p256dh, auth FROM push_registrations WHERE ${where} = ?`,
    )
    .bind(value)
    .all<RegistrationRow>();
  return results;
}

const rowOf = (sessionId: string, userId: string, body: Subscription) => ({
  id: expect.any(String),
  user_id: userId,
  session_id: sessionId,
  endpoint: body.endpoint,
  p256dh: body.keys.p256dh,
  auth: body.keys.auth,
});

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

  it("どちらかがない、または形が正しくなければ、使えないと返し、登録の PUT は 501、DELETE は 204。形の誤りはログに出す", async () => {
    const user = await createUser();
    const { headers } = await sessionFor(user.id);
    const body = await subscription();
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
        const put = await register(platform, headers, body);
        expect(put.status, label).toBe(501);
        expect(await put.json()).toMatchObject({ error: { code: "feature_unavailable" } });
        expect((await unregister(platform, headers)).status, label).toBe(204);
      } finally {
        errors.mockRestore();
      }
    }
    expect(await registrations("user_id", user.id)).toEqual([]);
  });

  it("使えない設定にしたあとも、登録は DELETE で外せる", async () => {
    const user = await createUser();
    const { headers } = await sessionFor(user.id);
    expect((await register(platformFor(PUSH_ENV), headers, await subscription())).status).toBe(204);

    expect((await unregister(platformFor({}), headers)).status).toBe(204);

    expect(await registrations("user_id", user.id)).toEqual([]);
  });

  it("有無と公開鍵は、アクセストークンでも読める", async () => {
    const platform = platformFor(PUSH_ENV);
    const fromSession = await readStatus(platform, await createSessionHeaders(TEST_USER.id));

    const res = await requestApp(platform, "/api/v1/push");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(fromSession);
  });

  it("登録の置き外しは、アクセストークンでは使えない（403 session_required）", async () => {
    const platform = platformFor(PUSH_ENV);
    const body = await subscription();
    const responses = [
      await requestApp(platform, "/api/v1/push/registration", { method: "PUT", json: body }),
      await requestApp(platform, "/api/v1/push/registration", { method: "DELETE" }),
    ];

    for (const res of responses) {
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: { code: "session_required" } });
    }
    expect(await registrations("endpoint", body.endpoint)).toEqual([]);
  });
});

describe("端末の登録", () => {
  const platform = platformFor(PUSH_ENV);

  it("登録を置くと 1 つになる。同じ登録を送り直しても 1 つのまま、行も変わらない", async () => {
    const user = await createUser();
    const { sessionId, headers } = await sessionFor(user.id);
    const body = await subscription();

    expect((await register(platform, headers, body)).status).toBe(204);
    const placed = await registrations("user_id", user.id);
    expect(placed).toEqual([rowOf(sessionId, user.id, body)]);

    expect((await register(platform, headers, body)).status).toBe(204);
    // base64url のパディングの有無が違うだけなら、同じ登録
    const padded = {
      ...body,
      keys: { p256dh: `${body.keys.p256dh}=`, auth: `${body.keys.auth}==` },
    };
    expect((await register(platform, headers, padded)).status).toBe(204);
    expect(await registrations("user_id", user.id)).toEqual(placed);
  });

  it("同じセッションでエンドポイントか鍵が違えば、新しい ID の行に置き換わる", async () => {
    const user = await createUser();
    const { sessionId, headers } = await sessionFor(user.id);
    const first = await subscription();
    await register(platform, headers, first);
    const [before] = await registrations("user_id", user.id);

    const moved = { ...first, endpoint: newEndpoint() };
    expect((await register(platform, headers, moved)).status).toBe(204);
    const afterMove = await registrations("user_id", user.id);
    expect(afterMove).toEqual([rowOf(sessionId, user.id, moved)]);
    expect(afterMove[0]?.id).not.toBe(before?.id);

    const rekeyed = { ...moved, keys: await deviceKeys() };
    expect((await register(platform, headers, rekeyed)).status).toBe(204);
    const afterRekey = await registrations("user_id", user.id);
    expect(afterRekey).toEqual([rowOf(sessionId, user.id, rekeyed)]);
    expect(afterRekey[0]?.id).not.toBe(afterMove[0]?.id);
  });

  it("ほかのセッションが同じエンドポイントを送ると、前の登録は外れる（ほかの人の登録でも）", async () => {
    const previous = await createUser();
    const next = await createUser();
    const first = await sessionFor(previous.id);
    const second = await sessionFor(next.id);
    const body = await subscription();
    await register(platform, first.headers, body);

    expect((await register(platform, second.headers, body)).status).toBe(204);

    expect(await registrations("endpoint", body.endpoint)).toEqual([
      rowOf(second.sessionId, next.id, body),
    ]);
    expect(await registrations("user_id", previous.id)).toEqual([]);
  });

  it("解除すると外れ、もう一度解除しても 204。ほかのセッションの登録は外さない", async () => {
    const user = await createUser();
    const phone = await sessionFor(user.id);
    const laptop = await sessionFor(user.id);
    const laptopBody = await subscription();
    await register(platform, phone.headers, await subscription());
    await register(platform, laptop.headers, laptopBody);

    expect((await unregister(platform, phone.headers)).status).toBe(204);
    expect((await unregister(platform, phone.headers)).status).toBe(204);

    expect(await registrations("user_id", user.id)).toEqual([
      rowOf(laptop.sessionId, user.id, laptopBody),
    ]);
  });

  it("ほかのサイトからは置けない（クッキーで認証した状態を変えるリクエスト）", async () => {
    const user = await createUser();
    const { headers } = await sessionFor(user.id);

    const res = await register(
      platform,
      { ...headers, "sec-fetch-site": "cross-site" },
      await subscription(),
    );

    expect(res.status).toBe(403);
    expect(await registrations("user_id", user.id)).toEqual([]);
  });

  it("エンドポイントは 2,048 文字ちょうどまで、鍵は 65 バイトと 16 バイトちょうどなら置ける", async () => {
    const user = await createUser();
    const { sessionId, headers } = await sessionFor(user.id);
    const prefix = "https://push.example.com/";
    const body = await subscription(prefix + "a".repeat(2048 - prefix.length));

    expect((await register(platform, headers, body)).status).toBe(204);

    expect(await registrations("user_id", user.id)).toEqual([rowOf(sessionId, user.id, body)]);
  });

  it("エンドポイントか鍵の形が正しくなければ 400 で、何も置かない。値はエラーに出さない", async () => {
    const user = await createUser();
    const { headers } = await sessionFor(user.id);
    const valid = await subscription();
    const point = base64UrlDecode(valid.keys.p256dh) ?? new Uint8Array();
    const bytes = (length: number) =>
      base64UrlEncode(crypto.getRandomValues(new Uint8Array(length)));
    const withFirstByte = (first: number) =>
      base64UrlEncode(Uint8Array.of(first, ...point.slice(1)));
    const offCurve = Uint8Array.from(point);
    offCurve[64] = (offCurve[64] ?? 0) ^ 1;
    const prefix = "https://push.example.com/";

    const cases: { name: string; endpoint?: string; p256dh?: string; auth?: string }[] = [
      { name: "http", endpoint: "http://push.example.com/send/1" },
      { name: "https でない", endpoint: "ftp://push.example.com/send/1" },
      { name: "URL でない", endpoint: "push.example.com/send/1" },
      { name: "手元のホスト", endpoint: "https://localhost/send/1" },
      { name: "内部の IP", endpoint: "https://10.0.0.1/send/1" },
      { name: "内部の名前", endpoint: "https://push.internal/send/1" },
      { name: "標準でないポート", endpoint: "https://push.example.com:9999/send/1" },
      { name: "URL の中の認証情報", endpoint: "https://user:pass@push.example.com/send/1" },
      { name: "2,049 文字", endpoint: prefix + "a".repeat(2049 - prefix.length) },
      // 送られた形は 2,048 文字でも、正規化すると é が %C3%A9 になって 2,053 文字
      {
        name: "正規化すると 2,048 文字を超える",
        endpoint: `${prefix}${"a".repeat(2047 - prefix.length)}é`,
      },
      { name: "p256dh が 64 バイト", p256dh: base64UrlEncode(point.slice(0, 64)) },
      { name: "p256dh が 66 バイト", p256dh: base64UrlEncode(Uint8Array.of(...point, 0)) },
      { name: "p256dh が圧縮した点", p256dh: withFirstByte(0x02).slice(0, 44) },
      { name: "p256dh が hybrid の点", p256dh: withFirstByte(0x06 | ((point[64] ?? 0) & 1)) },
      { name: "p256dh が曲線の上にない", p256dh: base64UrlEncode(offCurve) },
      { name: "p256dh が base64url でない", p256dh: `${valid.keys.p256dh.slice(1)}!` },
      { name: "auth が 15 バイト", auth: bytes(15) },
      { name: "auth が 17 バイト", auth: bytes(17) },
      { name: "auth が base64url でない", auth: "not base64url!!" },
    ];
    for (const { name, endpoint, p256dh, auth } of cases) {
      const body = {
        endpoint: endpoint ?? valid.endpoint,
        keys: { p256dh: p256dh ?? valid.keys.p256dh, auth: auth ?? valid.keys.auth },
      };
      const res = await register(platform, headers, body);

      expect(res.status, name).toBe(400);
      const text = await res.text();
      expect(JSON.parse(text), name).toMatchObject({ error: { code: "invalid_request" } });
      for (const secret of [body.endpoint, body.keys.p256dh, body.keys.auth]) {
        expect(text, name).not.toContain(secret);
      }
    }
    expect(await registrations("user_id", user.id)).toEqual([]);
  });

  it("同じエンドポイントを 2 つのセッションが同時に送っても、登録は 1 つ", async () => {
    const previous = await createUser();
    const next = await createUser();
    const first = await sessionFor(previous.id);
    const second = await sessionFor(next.id);
    const body = await subscription();
    // first の書く文の直前に、second の登録がすべて終わる
    const hook = statementHook(/insert or replace into "push_registrations"/i, async () => {
      expect((await register(platform, second.headers, body)).status).toBe(204);
    });

    const res = await register(platformFor(PUSH_ENV, { db: hook.db }), first.headers, body);

    expect(hook.fired()).toBe(true);
    expect(res.status).toBe(204);
    expect(await registrations("endpoint", body.endpoint)).toEqual([
      rowOf(first.sessionId, previous.id, body),
    ]);
  });

  it("認証したあと、書く前にログアウトされたら、何も置かない", async () => {
    const user = await createUser();
    const { headers } = await sessionFor(user.id);
    const hook = statementHook(/insert or replace into "push_registrations"/i, async () => {
      const logout = await requestApp(platform, "/api/v1/auth/logout", {
        method: "POST",
        token: null,
        headers,
      });
      expect(logout.status).toBe(204);
    });

    const res = await register(
      platformFor(PUSH_ENV, { db: hook.db }),
      headers,
      await subscription(),
    );

    expect(hook.fired()).toBe(true);
    expect(res.status).toBe(204);
    expect(await registrations("user_id", user.id)).toEqual([]);
  });

  it("認証したあと、書く前にセッションの期限が来たら、何も置かない。期限ちょうどから切れたとみなす", async () => {
    const user = await createUser();
    const { sessionId, headers } = await sessionFor(user.id);
    const at = Date.now();
    // 認証と書く文の間に期限が来るのは、時刻をちょうどに合わせないと起きないので、期限を直接書き換える
    const expireAt = (expiresAt: number) =>
      testDb
        .prepare("UPDATE sessions SET expires_at = ? WHERE id = ?")
        .bind(expiresAt, sessionId)
        .run();
    const hook = statementHook(/insert or replace into "push_registrations"/i, async () => {
      await expireAt(at);
    });
    const clocked = { ...platformFor(PUSH_ENV, { db: hook.db }), now: () => new Date(at) };

    const res = await register(clocked, headers, await subscription());

    expect(hook.fired()).toBe(true);
    expect(res.status).toBe(204);
    expect(await registrations("user_id", user.id)).toEqual([]);

    // 期限が 1 ミリ秒でも先なら置ける
    await expireAt(at + 1);
    const body = await subscription();
    expect((await register(clocked, headers, body)).status).toBe(204);
    expect(await registrations("user_id", user.id)).toEqual([rowOf(sessionId, user.id, body)]);
  });
});

describe("ログインと登録", () => {
  async function setup(emails: string[]) {
    const google = await createFakeGoogle();
    const platform = platformFor(
      {
        ...PUSH_ENV,
        GOOGLE_CLIENT_ID: GOOGLE_CLIENT.clientId,
        GOOGLE_CLIENT_SECRET: GOOGLE_CLIENT.clientSecret,
        ALLOWED_EMAILS: emails.join(","),
      },
      { fetch: google.fetch },
    );
    return { platform, google };
  }

  const registerFrom = async (platform: Platform, jar: Jar, body: Subscription) => {
    const res = await send(platform, "/api/v1/push/registration", {
      jar,
      method: "PUT",
      headers: { "sec-fetch-site": "same-origin" },
      body,
    });
    expect(res.status).toBe(204);
  };

  it("その端末でログアウトすると、その端末の登録は外れる。ほかの端末の登録は残る", async () => {
    const email = `${crypto.randomUUID()}@example.com`;
    const { platform, google } = await setup([email]);
    const sub = crypto.randomUUID();
    const { jar: phone } = await login(platform, google, { email, sub });
    const { jar: laptop } = await login(platform, google, { email, sub });
    const phoneBody = await subscription();
    const laptopBody = await subscription();
    await registerFrom(platform, phone, phoneBody);
    await registerFrom(platform, laptop, laptopBody);

    const logout = await send(platform, "/api/v1/auth/logout", {
      jar: phone,
      method: "POST",
      headers: { "sec-fetch-site": "same-origin" },
    });

    expect(logout.status).toBe(204);
    expect(await registrations("endpoint", phoneBody.endpoint)).toEqual([]);
    expect(await registrations("endpoint", laptopBody.endpoint)).toHaveLength(1);
  });

  it("同じブラウザで別の人がログインすると、前の人の登録は外れる", async () => {
    const before = `${crypto.randomUUID()}@example.com`;
    const after = `${crypto.randomUUID()}@example.com`;
    const { platform, google } = await setup([before, after]);
    const { jar } = await login(platform, google, { email: before });
    const body = await subscription();
    await registerFrom(platform, jar, body);
    const [previous] = await registrations("endpoint", body.endpoint);

    await login(platform, google, { email: after, jar });

    expect(await registrations("user_id", previous?.user_id ?? "")).toEqual([]);
    // reader がログインのあとに送り直すと、次の人の登録になる
    await registerFrom(platform, jar, body);
    const [next] = await registrations("endpoint", body.endpoint);
    expect(next?.user_id).not.toBe(previous?.user_id);
  });
});

describe("期限の切れたセッションの登録", () => {
  it("1 日 1 回の片付けで消える。期限ちょうどから切れたとみなし、まだのセッションの登録は残す", async () => {
    const platform = platformFor(PUSH_ENV);
    const user = await createUser();
    const expiring = await sessionFor(user.id);
    const active = await sessionFor(user.id);
    const activeBody = await subscription();
    await register(platform, expiring.headers, await subscription());
    await register(platform, active.headers, activeBody);
    // 期限の切れたセッションは、本番では 30 日待たないとできないので、期限を直接書き換える
    const expiresAt = Date.now() - 60_000;
    await testDb
      .prepare("UPDATE sessions SET expires_at = ? WHERE id = ?")
      .bind(expiresAt, expiring.sessionId)
      .run();
    const cleanUpAt = (time: number) => runCleanUp({ ...platform, now: () => new Date(time) });

    expect(await cleanUpAt(expiresAt - 1)).toMatchObject({ pushRegistrations: 0 });
    expect(await registrations("session_id", expiring.sessionId)).toHaveLength(1);

    expect(await cleanUpAt(expiresAt)).toMatchObject({ pushRegistrations: 1 });
    expect(await registrations("user_id", user.id)).toEqual([
      rowOf(active.sessionId, user.id, activeBody),
    ]);
  });
});
