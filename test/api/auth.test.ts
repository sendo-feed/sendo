import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { accessTokens, users } from "../../src/db/schema";
import { createAccessToken, generateToken, hashToken, TOKEN_PREFIX } from "../../src/db/tokens";
import { createTestPlatform, requestApp } from "../helpers";

async function createUserWithToken(now: Date) {
  const { platform } = createTestPlatform({ now: () => now });
  const userId = crypto.randomUUID();
  await platform.db
    .insert(users)
    .values({ id: userId, email: `${userId}@example.com`, createdAt: now })
    .run();
  const { token, record } = await createAccessToken(platform.db, { userId, name: "test", now });
  return { platform, userId, token, tokenId: record.id };
}

const lastUsedAt = async (tokenId: string) =>
  (
    await createTestPlatform()
      .platform.db.select()
      .from(accessTokens)
      .where(eq(accessTokens.id, tokenId))
      .get()
  )?.lastUsedAt;

describe("アクセストークン", () => {
  it("sendo_ で始まる、推測できない文字列を作る。DB にはハッシュだけを置く", async () => {
    const a = generateToken();
    const b = generateToken();

    expect(a).toMatch(/^sendo_[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
    expect(await hashToken(a)).toMatch(/^[0-9a-f]{64}$/);

    const { token, tokenId } = await createUserWithToken(new Date());
    const row = await createTestPlatform()
      .platform.db.select()
      .from(accessTokens)
      .where(eq(accessTokens.id, tokenId))
      .get();
    expect(row?.tokenHash).toBe(await hashToken(token));
    expect(JSON.stringify(row)).not.toContain(token);
  });

  it("発行したトークンで API を使える", async () => {
    const { platform, token } = await createUserWithToken(new Date());

    expect((await requestApp(platform, "/api/v1/feeds", { token })).status).toBe(200);
  });

  it.each([
    ["sendo_ で始まらない", "test-token"],
    ["発行していない", `${TOKEN_PREFIX}unknown`],
    ["空", ""],
  ])("%s トークンは 401", async (_label, token) => {
    const { platform } = createTestPlatform();
    const res = await requestApp(platform, "/api/v1/feeds", { token });

    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
  });

  it("取り消したトークンは使えない", async () => {
    const { platform, token, tokenId } = await createUserWithToken(new Date());
    await env.DB.prepare("DELETE FROM access_tokens WHERE id = ?").bind(tokenId).run();

    expect((await requestApp(platform, "/api/v1/feeds", { token })).status).toBe(401);
  });

  it("ユーザーを消すと、そのユーザーのトークンも消える", async () => {
    const { platform, token, userId, tokenId } = await createUserWithToken(new Date());
    await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(userId).run();

    expect((await requestApp(platform, "/api/v1/feeds", { token })).status).toBe(401);
    expect(await lastUsedAt(tokenId)).toBeUndefined();
  });

  it("最後に使った時刻は、1 時間に 1 回だけ書き直す", async () => {
    const t0 = new Date("2026-11-14T00:00:00Z");
    const { token, tokenId } = await createUserWithToken(t0);
    const at = (iso: string) => createTestPlatform({ now: () => new Date(iso) }).platform;

    await requestApp(at("2026-11-14T00:00:00Z"), "/api/v1/feeds", { token });
    expect(await lastUsedAt(tokenId)).toEqual(t0);

    await requestApp(at("2026-11-14T00:30:00Z"), "/api/v1/feeds", { token });
    expect(await lastUsedAt(tokenId)).toEqual(t0);

    await requestApp(at("2026-11-14T01:00:00Z"), "/api/v1/feeds", { token });
    expect(await lastUsedAt(tokenId)).toEqual(new Date("2026-11-14T01:00:00Z"));
  });
});
