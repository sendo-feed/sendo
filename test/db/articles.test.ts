import { describe, expect, it } from "vitest";
import { insertFeed } from "../../src/db/feeds";
import { testDb } from "../db";
import { createTestPlatform, uniqueUrl } from "../helpers";

describe("記事の公開時刻の印（docs/decisions/jobs.md の 11）", () => {
  it("印の列を指定せずに入れた行（列を足す前の行と同じ）は、公開時刻が分からないものになる", async () => {
    const { platform } = createTestPlatform();
    const now = new Date("2026-11-20T00:00:00Z");
    const { feed } = await insertFeed(platform.db, {
      id: crypto.randomUUID(),
      url: uniqueUrl(),
      now,
    });
    const id = crypto.randomUUID();
    await testDb
      .prepare(
        "INSERT INTO articles (id, feed_id, guid, published_at, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(id, feed.id, "old", now.getTime(), now.getTime())
      .run();

    expect(
      await testDb
        .prepare("SELECT published_time_known FROM articles WHERE id = ?")
        .bind(id)
        .first("published_time_known"),
    ).toBe(0);
  });
});
