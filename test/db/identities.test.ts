import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { identities, users } from "../../src/db/schema";
import { createTestPlatform } from "../helpers";

describe("提供元のログイン（identities）", () => {
  it("1 人のユーザーが、複数の提供元のログインを持てる", async () => {
    const { platform } = createTestPlatform();
    const now = new Date();
    await platform.db
      .insert(users)
      .values({ id: "multi", email: "multi@example.com", createdAt: now })
      .run();
    await platform.db
      .insert(identities)
      .values([
        {
          id: "g",
          userId: "multi",
          issuer: "https://accounts.google.com",
          subject: "1",
          email: "multi@example.com",
          createdAt: now,
        },
        {
          id: "h",
          userId: "multi",
          issuer: "https://github.com",
          subject: "1",
          email: "multi@example.com",
          createdAt: now,
        },
      ])
      .run();

    const rows = await env.DB.prepare(
      "SELECT issuer FROM identities WHERE user_id = ? ORDER BY issuer",
    )
      .bind("multi")
      .all<{ issuer: string }>();
    expect(rows.results.map((row) => row.issuer)).toEqual([
      "https://accounts.google.com",
      "https://github.com",
    ]);
  });

  it("同じ提供元の同じ ID は、1 人にしか結び付かない", async () => {
    const { platform } = createTestPlatform();
    const now = new Date();
    await platform.db
      .insert(users)
      .values([
        { id: "u1", email: "u1@example.com", createdAt: now },
        { id: "u2", email: "u2@example.com", createdAt: now },
      ])
      .run();
    const identity = {
      issuer: "https://accounts.google.com",
      subject: "same",
      email: "x@example.com",
      createdAt: now,
    };
    await platform.db
      .insert(identities)
      .values({ id: "i1", userId: "u1", ...identity })
      .run();

    await expect(
      platform.db
        .insert(identities)
        .values({ id: "i2", userId: "u2", ...identity })
        .run(),
    ).rejects.toThrow();
  });

  it("ユーザーを消すと、提供元のログインも消える", async () => {
    const { platform } = createTestPlatform();
    const now = new Date();
    await platform.db
      .insert(users)
      .values({ id: "gone", email: "gone@example.com", createdAt: now })
      .run();
    await platform.db
      .insert(identities)
      .values({
        id: "ig",
        userId: "gone",
        issuer: "https://accounts.google.com",
        subject: "gone",
        email: "gone@example.com",
        createdAt: now,
      })
      .run();

    await env.DB.prepare("DELETE FROM users WHERE id = ?").bind("gone").run();

    const left = await env.DB.prepare("SELECT count(*) AS n FROM identities WHERE id = ?")
      .bind("ig")
      .first<{ n: number }>();
    expect(left?.n).toBe(0);
  });
});
