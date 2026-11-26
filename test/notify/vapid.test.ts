import { describe, expect, it } from "vitest";
import {
  getVapidPublicKey,
  VAPID_TOKEN_LIFETIME_MS,
  VAPID_TOKEN_REUSE_MS,
  vapidAuthorization,
} from "../../src/notify/vapid";
import { testDatabase } from "../db";
import { verifyVapid } from "../push-service";

const SUBJECT = "mailto:admin@example.com";
const NOW = new Date("2026-11-27T00:00:00.000Z");

/** テストごとに重ならない送り先（JWT はプロセスのメモリに、送り先のオリジンごとに持つ） */
const endpointAt = (origin = `https://${crypto.randomUUID()}.push.example`) =>
  `${origin}/send/${crypto.randomUUID()}`;

const authorize = (endpoint: string, now = NOW, subject = SUBJECT) =>
  vapidAuthorization(testDatabase.db, { subject, endpoint, now });

describe("VAPID（RFC 8292）", () => {
  it("ES256 の JWT に、送り先のオリジン、作った時刻の 12 時間後の exp、sub を入れ、sendo の公開鍵を k に付ける", async () => {
    const endpoint = endpointAt();

    const vapid = await verifyVapid(await authorize(endpoint));

    expect(vapid.header).toEqual({ typ: "JWT", alg: "ES256" });
    expect(vapid.claims).toEqual({
      aud: new URL(endpoint).origin,
      exp: (NOW.getTime() + VAPID_TOKEN_LIFETIME_MS) / 1000,
      sub: SUBJECT,
    });
    expect(vapid.publicKey).toBe(await getVapidPublicKey(testDatabase.db));
  });

  it("同じオリジンには、作ってから 6 時間になるまで同じ JWT を使い、6 時間ちょうどで作り直す", async () => {
    const origin = `https://${crypto.randomUUID()}.push.example`;
    const first = await verifyVapid(await authorize(endpointAt(origin)));

    const later = await verifyVapid(
      await authorize(endpointAt(origin), new Date(NOW.getTime() + VAPID_TOKEN_REUSE_MS - 1)),
    );
    const renewedAt = new Date(NOW.getTime() + VAPID_TOKEN_REUSE_MS);
    const renewed = await verifyVapid(await authorize(endpointAt(origin), renewedAt));

    expect(later.token).toBe(first.token);
    expect(renewed.token).not.toBe(first.token);
    expect(renewed.claims.exp).toBe((renewedAt.getTime() + VAPID_TOKEN_LIFETIME_MS) / 1000);
  });

  it("オリジンが違えば、別の JWT を作る", async () => {
    const a = await verifyVapid(await authorize(endpointAt()));
    const b = await verifyVapid(await authorize(endpointAt()));

    expect(a.token).not.toBe(b.token);
    expect(a.claims.aud).not.toBe(b.claims.aud);
  });

  it("同じオリジンへ同時に送っても、作るのは 1 つで、どれも同じ JWT を使う", async () => {
    // ECDSA の署名は毎回変わるので、別々に作れば JWT は違うものになる
    const origin = `https://${crypto.randomUUID()}.push.example`;

    const all = await Promise.all(
      Array.from({ length: 5 }, () => authorize(endpointAt(origin)).then(verifyVapid)),
    );

    expect(new Set(all.map((vapid) => vapid.token)).size).toBe(1);
  });

  it("時計が作った時刻より前に戻ったら、作り直す", async () => {
    const origin = `https://${crypto.randomUUID()}.push.example`;
    const first = await verifyVapid(await authorize(endpointAt(origin)));

    const earlier = await verifyVapid(
      await authorize(endpointAt(origin), new Date(NOW.getTime() - 1)),
    );

    expect(earlier.token).not.toBe(first.token);
  });
});
