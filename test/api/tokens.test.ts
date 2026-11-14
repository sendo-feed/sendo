import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createSessionHeaders, createTestPlatform, createUser, requestApp } from "../helpers";

type TokenJson = { id: string; name: string; createdAt: string; lastUsedAt: string | null };

/** ブラウザでログインしている人（セッション）として送る */
async function signedIn() {
  const user = await createUser();
  const headers = await createSessionHeaders(user.id);
  // 発行の順が一覧の順になるよう、呼ぶたびに 1 秒進む時計にする（同じミリ秒だと順が決まらない）
  let clock = Date.now();
  const { platform } = createTestPlatform({
    now: () => {
      clock += 1000;
      return new Date(clock);
    },
  });
  const send = (path: string, init: { method?: string; json?: unknown } = {}) =>
    requestApp(platform, path, { ...init, token: null, headers });
  return { platform, user, send };
}

describe("アクセストークンの発行・一覧・取り消し", () => {
  it("ブラウザでログインした人が発行し、その中身で API を使える。中身は発行したときにしか返さない", async () => {
    const { platform, send } = await signedIn();

    const created = await send("/api/v1/tokens", { method: "POST", json: { name: "  Reeder  " } });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { token: string; accessToken: TokenJson };
    expect(body.token).toMatch(/^sendo_[A-Za-z0-9_-]{43}$/);
    expect(body.accessToken).toMatchObject({ name: "Reeder", lastUsedAt: null });

    // 発行したトークンで API を使える
    expect((await requestApp(platform, "/api/v1/feeds", { token: body.token })).status).toBe(200);

    // 一覧には中身を出さない。使った時刻が入る
    const list = await send("/api/v1/tokens");
    const text = await list.text();
    expect(text).not.toContain(body.token);
    const items = (JSON.parse(text) as { items: TokenJson[] }).items;
    expect(items.map((item) => item.id)).toContain(body.accessToken.id);
    expect(items.find((item) => item.id === body.accessToken.id)?.lastUsedAt).not.toBeNull();
  });

  it("一覧は新しい順で、ほかの人のトークンは出ない", async () => {
    const { send } = await signedIn();
    await send("/api/v1/tokens", { method: "POST", json: { name: "first" } });
    await send("/api/v1/tokens", { method: "POST", json: { name: "second" } });
    const other = await signedIn();
    await other.send("/api/v1/tokens", { method: "POST", json: { name: "other" } });

    const items = ((await (await send("/api/v1/tokens")).json()) as { items: TokenJson[] }).items;

    // createUser が発行した "test" も、この人のトークン
    expect(items.map((item) => item.name)).toEqual(["second", "first", "test"]);
  });

  it("取り消すと、そのトークンはすぐに使えなくなる。ほかの人のトークンは取り消せない（404）", async () => {
    const { platform, send } = await signedIn();
    const mine = (await (
      await send("/api/v1/tokens", { method: "POST", json: { name: "CLI" } })
    ).json()) as { token: string; accessToken: TokenJson };
    const other = await signedIn();
    const theirs = (await (
      await other.send("/api/v1/tokens", { method: "POST", json: { name: "CLI" } })
    ).json()) as { token: string; accessToken: TokenJson };

    expect(
      (await send(`/api/v1/tokens/${theirs.accessToken.id}`, { method: "DELETE" })).status,
    ).toBe(404);
    expect((await requestApp(platform, "/api/v1/feeds", { token: theirs.token })).status).toBe(200);

    expect((await send(`/api/v1/tokens/${mine.accessToken.id}`, { method: "DELETE" })).status).toBe(
      204,
    );
    expect((await requestApp(platform, "/api/v1/feeds", { token: mine.token })).status).toBe(401);
    expect((await send(`/api/v1/tokens/${mine.accessToken.id}`, { method: "DELETE" })).status).toBe(
      404,
    );
  });

  it("アクセストークンでは使えない（漏れたトークンで、新しいトークンを発行させない）", async () => {
    const { platform, user } = await signedIn();
    const before = await env.DB.prepare("SELECT count(*) AS n FROM access_tokens WHERE user_id = ?")
      .bind(user.id)
      .first<{ n: number }>();

    for (const [method, path, json] of [
      ["GET", "/api/v1/tokens", undefined],
      ["POST", "/api/v1/tokens", { name: "stolen" }],
      ["DELETE", "/api/v1/tokens/whatever", undefined],
    ] as const) {
      const res = await requestApp(platform, path, {
        method,
        token: user.token,
        ...(json && { json }),
      });
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(await res.json()).toMatchObject({ error: { code: "session_required" } });
    }
    const after = await env.DB.prepare("SELECT count(*) AS n FROM access_tokens WHERE user_id = ?")
      .bind(user.id)
      .first<{ n: number }>();
    expect(after?.n).toBe(before?.n);
  });

  it("名前は、前後の空白を除いて 1〜100 文字", async () => {
    const { send } = await signedIn();

    for (const name of ["", "   ", "x".repeat(101)]) {
      const res = await send("/api/v1/tokens", { method: "POST", json: { name } });
      expect(res.status, JSON.stringify(name)).toBe(400);
    }
    const longest = await send("/api/v1/tokens", {
      method: "POST",
      json: { name: "x".repeat(100) },
    });
    expect(longest.status).toBe(201);
  });

  it("ほかのサイトからは発行させない（クッキーで認証した、状態を変えるリクエスト）", async () => {
    const user = await createUser();
    const headers = await createSessionHeaders(user.id);
    const { platform } = createTestPlatform();

    const res = await requestApp(platform, "/api/v1/tokens", {
      method: "POST",
      token: null,
      headers: { ...headers, "sec-fetch-site": "cross-site" },
      json: { name: "csrf" },
    });

    expect(res.status).toBe(403);
  });
});
