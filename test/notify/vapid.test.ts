import { describe, expect, it } from "vitest";
import {
  discardRefusedVapidToken,
  getVapidPublicKey,
  VAPID_MIN_RENEW_INTERVAL_MS,
  VAPID_TOKEN_LIFETIME_MS,
  VAPID_TOKEN_REUSE_MS,
  vapidAuthorization,
} from "../../src/notify/vapid";
import { testDatabase } from "../db";
import { statementHook } from "../helpers";
import { verifyVapid } from "../push-service";

const SUBJECT = "mailto:admin@example.com";
const NOW = new Date("2026-11-27T00:00:00.000Z");

/** テストごとに重ならない送り先（JWT はプロセスのメモリに、送り先のオリジンごとに持つ） */
const endpointAt = (origin = `https://${crypto.randomUUID()}.push.example`) =>
  `${origin}/send/${crypto.randomUUID()}`;

const authorize = (endpoint: string, now: Date | (() => Date) = NOW, subject = SUBJECT) =>
  vapidAuthorization(testDatabase.db, {
    subject,
    endpoint,
    now: typeof now === "function" ? now : () => now,
  });

/** プッシュサービスが 401 ／ 403 で断った */
const refuse = (endpoint: string, now: Date) =>
  discardRefusedVapidToken(testDatabase.db, { subject: SUBJECT, endpoint, now: () => now });

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

  it("鍵を読んでいる間に、あとから始めた送信が同じオリジンの JWT を作っても、それを使う", async () => {
    // 時刻は、鍵を読み、作っている途中の JWT を待ち終えてから読む。始めたときに読むと、あとから
    // 作られた JWT の作った時刻が「今」より後になり、時計が戻ったとみなして作り直してしまう
    const origin = `https://${crypto.randomUUID()}.push.example`;
    let ms = NOW.getTime();
    const clock = () => new Date(ms);
    let later: Promise<string> | undefined;
    const { db, fired } = statementHook(/"app_secrets"/, async () => {
      ms += 60 * 1000;
      later = authorize(endpointAt(origin), clock);
      await later;
    });

    const first = await vapidAuthorization(db, {
      subject: SUBJECT,
      endpoint: endpointAt(origin),
      now: clock,
    });

    expect(fired()).toBe(true);
    if (!later) throw new Error("the later send did not run");
    expect((await verifyVapid(first)).token).toBe((await verifyVapid(await later)).token);
  });

  it("時計が作った時刻より前に戻ったら、作り直す。作った時刻と同じなら使い回す", async () => {
    const origin = `https://${crypto.randomUUID()}.push.example`;
    const first = await verifyVapid(await authorize(endpointAt(origin)));

    const same = await verifyVapid(await authorize(endpointAt(origin), NOW));
    const earlier = await verifyVapid(
      await authorize(endpointAt(origin), new Date(NOW.getTime() - 1)),
    );

    expect(same.token).toBe(first.token);
    expect(earlier.token).not.toBe(first.token);
  });

  it("断られたら、作ってから 1 時間以上たった JWT を捨て、次に作り直す。1 時間に 1 ミリ秒足りなければ捨てない", async () => {
    const origin = `https://${crypto.randomUUID()}.push.example`;
    const first = await verifyVapid(await authorize(endpointAt(origin)));

    const early = new Date(NOW.getTime() + VAPID_MIN_RENEW_INTERVAL_MS - 1);
    await refuse(endpointAt(origin), early);
    const kept = await verifyVapid(await authorize(endpointAt(origin), early));
    const onTime = new Date(NOW.getTime() + VAPID_MIN_RENEW_INTERVAL_MS);
    await refuse(endpointAt(origin), onTime);
    const renewed = await verifyVapid(await authorize(endpointAt(origin), onTime));

    expect(kept.token).toBe(first.token);
    expect(renewed.token).not.toBe(first.token);
    expect(renewed.claims.exp).toBe((onTime.getTime() + VAPID_TOKEN_LIFETIME_MS) / 1000);
  });

  it("捨てるのは、断ったオリジンの JWT だけ", async () => {
    const [kept, refused] = [0, 1].map(() => `https://${crypto.randomUUID()}.push.example`);
    const keptFirst = await verifyVapid(await authorize(endpointAt(kept)));
    const refusedFirst = await verifyVapid(await authorize(endpointAt(refused)));

    const later = new Date(NOW.getTime() + VAPID_MIN_RENEW_INTERVAL_MS);
    await refuse(endpointAt(refused), later);

    expect((await verifyVapid(await authorize(endpointAt(kept), later))).token).toBe(
      keptFirst.token,
    );
    expect((await verifyVapid(await authorize(endpointAt(refused), later))).token).not.toBe(
      refusedFirst.token,
    );
  });
});
