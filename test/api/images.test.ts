import { describe, expect, it } from "vitest";
import { appSecrets } from "../../src/db/schema";
import { imageSigner } from "../../src/db/secrets";
import { HTML, PNG, SVG } from "../fixtures/images";
import {
  createSessionHeaders,
  createTestPlatform,
  fakeFetch,
  requestApp,
  TEST_USER,
} from "../helpers";

const SOURCE = "https://img.example.com/a.png?x=1&y=2";

function setup(respond: Parameters<typeof fakeFetch>[0] = () => new Response(PNG)) {
  const fake = fakeFetch(respond);
  const { platform } = createTestPlatform({ fetch: fake.fetch });
  const relayUrl = async (url = SOURCE) => {
    const relay = await imageSigner(platform.db).toRelayUrl(url);
    if (relay === null) throw new Error("no relay url");
    return relay;
  };
  return { platform, calls: fake.calls, relayUrl };
}

describe("GET /api/v1/images", () => {
  it("署名した URL の画像を、中身で決めた Content-Type と守りのヘッダーを付けて返す", async () => {
    const { platform, relayUrl, calls } = setup(
      () =>
        new Response(PNG, {
          headers: { "content-type": "text/html", "set-cookie": "a=b", "x-upstream": "1" },
        }),
    );
    const res = await requestApp(platform, await relayUrl());

    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe("private, max-age=2592000");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    // 配信元の応答のヘッダーは写さない
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("x-upstream")).toBeNull();
    expect(calls.map((call) => call.url)).toEqual([SOURCE]);
  });

  it("配った URL は /api/v1/images のパスで、そのまま開ける（オリジンは付かない）", async () => {
    const { relayUrl } = setup();
    const relay = await relayUrl();
    expect(relay).toMatch(
      /^\/api\/v1\/images\?url=https%3A%2F%2Fimg\.example\.com%2F.*&sig=[\w-]{22}$/,
    );
    expect(new URL(relay, "https://reader.example").searchParams.get("url")).toBe(SOURCE);
  });

  it("セッションのクッキーだけで通る（<img> は Authorization を付けられない）", async () => {
    const { platform, relayUrl } = setup();
    const { cookie } = await createSessionHeaders(TEST_USER.id);
    const res = await requestApp(platform, await relayUrl(), { token: null, headers: { cookie } });
    expect(res.status).toBe(200);
    await res.body?.cancel();
  });

  it("読者のリクエストのヘッダーを、配信元に渡さない", async () => {
    const { platform, relayUrl, calls } = setup();
    const { cookie } = await createSessionHeaders(TEST_USER.id);
    const res = await requestApp(platform, await relayUrl(), {
      token: null,
      headers: {
        cookie,
        referer: "https://reader.example/articles/1",
        "user-agent": "Mozilla/5.0 (reader)",
        "accept-language": "ja",
        "x-forwarded-for": "203.0.113.9",
        "cf-connecting-ip": "203.0.113.9",
        "x-real-ip": "203.0.113.9",
      },
    });
    await res.body?.cancel();

    const sent = calls[0]?.headers;
    expect([...(sent?.keys() ?? [])].sort()).toEqual(["accept", "user-agent"]);
    expect(sent?.get("user-agent")).toMatch(/^Sendo\//);
  });

  it("認証がなければ 401 で、配信元に取りにいかない", async () => {
    const { platform, relayUrl, calls } = setup();
    const res = await requestApp(platform, await relayUrl(), { token: null });
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("署名が合わなければ 403 で、配信元に取りにいかない", async () => {
    const { platform, relayUrl, calls } = setup();
    const relay = await relayUrl();
    const sig = new URL(relay, "https://x.example").searchParams.get("sig") ?? "";
    const withUrl = (url: string, signature = sig) =>
      `/api/v1/images?url=${encodeURIComponent(url)}&sig=${signature}`;

    for (const path of [
      // 別の URL に、ほかの URL の署名を付ける（署名した URL に、クエリでデータを足す）
      withUrl(`${SOURCE}&leak=secret`),
      withUrl("https://attacker.example/collect?d=secret"),
      // 署名を変える、短くする、空にする、形の違うものにする。変えるのは先頭の文字にする。
      // 最後の文字は 6 ビットのうち 2 ビットしか使わない（16 バイトを base64url にすると 22 文字で、
      // 4 ビット余る）ので、A を B に変えても同じバイト列になり、署名が合ってしまう
      withUrl(SOURCE, `${sig.startsWith("A") ? "B" : "A"}${sig.slice(1)}`),
      withUrl(SOURCE, sig.slice(0, 10)),
      withUrl(SOURCE, ""),
      withUrl(SOURCE, "!!!"),
    ]) {
      const res = await requestApp(platform, path);
      expect(res.status, path).toBe(403);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toMatchObject({ error: { code: "invalid_signature" } });
    }
    expect(calls).toHaveLength(0);
  });

  it("url か sig がなければ 400", async () => {
    const { platform } = setup();
    expect((await requestApp(platform, "/api/v1/images")).status).toBe(400);
    expect(
      (await requestApp(platform, "/api/v1/images?url=https%3A%2F%2Fa.example%2F")).status,
    ).toBe(400);
  });

  it("画像でないもの（HTML、SVG）は 502 で、中身を返さない", async () => {
    for (const body of [HTML, SVG]) {
      const { platform, relayUrl } = setup(
        () => new Response(body, { headers: { "content-type": "image/png" } }),
      );
      const res = await requestApp(platform, await relayUrl());
      expect(res.status).toBe(502);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toMatchObject({ error: { code: "image_unavailable" } });
    }
  });

  it("配信元が失敗したら 502", async () => {
    const { platform, relayUrl } = setup(() => new Response(null, { status: 404 }));
    expect((await requestApp(platform, await relayUrl())).status).toBe(502);
  });

  it("署名した URL でも、内部の宛先やリダイレクトで内部に向かうものは 502", async () => {
    const direct = setup();
    const res = await requestApp(
      direct.platform,
      await direct.relayUrl("http://169.254.169.254/latest"),
    );
    expect(res.status).toBe(502);
    expect(direct.calls).toHaveLength(0);

    const redirected = setup(
      () =>
        new Response(null, { status: 302, headers: { location: "http://127.0.0.1/secret.png" } }),
    );
    expect((await requestApp(redirected.platform, await redirected.relayUrl())).status).toBe(502);
    expect(redirected.calls).toHaveLength(1);
  });

  it("鍵は 1 つだけ作られ、同じ URL には同じ署名が付く", async () => {
    const { platform, relayUrl } = setup();
    const [a, b, c] = await Promise.all([relayUrl(), relayUrl(), relayUrl()]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(await platform.db.select().from(appSecrets).all()).toHaveLength(1);
  });

  it("鍵を作り直すと、前に配った URL は 403 になる", async () => {
    const { platform, relayUrl } = setup();
    const old = await relayUrl();
    await platform.db.delete(appSecrets).run();
    expect((await requestApp(platform, old)).status).toBe(403);
    const res = await requestApp(platform, await relayUrl());
    expect(res.status).toBe(200);
    await res.body?.cancel();
  });
});
