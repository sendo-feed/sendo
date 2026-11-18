import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { SAVED_PAGE_LIMITS } from "../../src/db/saved";
import { runCleanUp } from "../../src/jobs/clean-up";
import { createTestPlatform, createUser, fakeFetch, requestApp } from "../helpers";

type Page = { id: string; url: string; title: string | null; savedAt: string };

describe("あとで読むページ", () => {
  it("外部に通信せず URL を保存し、再送と他の人の操作で変わらない", async () => {
    const { fetch, calls } = fakeFetch(() => new Response(null, { status: 403 }));
    const { platform } = createTestPlatform({ fetch });
    const other = await createUser();
    const save = (url: string, title?: string) =>
      requestApp(platform, "/api/v1/saved", { method: "PUT", json: { url, title } });
    const original = await save("https://X.com/sample/status/123#item", "投稿");
    expect(original.status).toBe(200);
    const { page } = (await original.json()) as { page: Page };
    expect(page).toMatchObject({ url: "https://x.com/sample/status/123#item", title: "投稿" });
    expect((await (await save(page.url, "別の入力")).json()) as unknown).toEqual({ page });
    expect(calls).toEqual([]);
    for (const url of ["javascript:alert(1)", "https://someone:secret@example.com/", "/relative"]) {
      expect((await save(url)).status).toBe(400);
    }
    expect((await requestApp(platform, "/api/v1/saved", { token: null })).status).toBe(401);
    await requestApp(platform, `/api/v1/saved/${page.id}`, {
      method: "DELETE",
      token: other.token,
    });
    expect(
      await (await requestApp(platform, "/api/v1/saved", { token: other.token })).json(),
    ).toEqual({
      items: [],
      nextCursor: null,
    });

    const second = (await (await save("https://example.com/article")).json()) as { page: Page };
    const first = (await (await requestApp(platform, "/api/v1/saved?limit=1")).json()) as {
      items: Page[];
      nextCursor: string;
    };
    const next = (await (
      await requestApp(platform, `/api/v1/saved?limit=1&cursor=${first.nextCursor}`)
    ).json()) as {
      items: Page[];
      nextCursor: string | null;
    };
    expect(new Set([...first.items, ...next.items].map((p) => p.id))).toEqual(
      new Set([page.id, second.page.id]),
    );
    expect(next.nextCursor).toBeNull();
  });

  it("保存を有効にした端末だけが保存と解除を同期し、解除の回収後は古いカーソルを拒否する", async () => {
    let now = new Date("2026-11-01T00:00:00Z");
    const { platform } = createTestPlatform({ now: () => now });
    const user = await createUser();
    const url = "https://example.com/read-later";
    const save = () =>
      requestApp(platform, "/api/v1/saved", { method: "PUT", token: user.token, json: { url } });
    const askSync = (include: boolean, cursor?: string) => {
      const query = new URLSearchParams();
      if (include) query.set("includeSaved", "true");
      if (cursor) query.set("cursor", cursor);
      return requestApp(platform, `/api/v1/sync?${query}`, { token: user.token });
    };
    const { page } = (await (await save()).json()) as { page: Page };
    const legacy = (await (await askSync(false)).json()) as { cursor: string };
    expect(legacy).not.toHaveProperty("savedPages");
    const initial = (await (await askSync(true, legacy.cursor)).json()) as { cursor: string };
    expect(initial).toMatchObject({ savedPages: [{ ...page, deleted: false }] });

    const remove = () =>
      requestApp(platform, `/api/v1/saved/${page.id}`, { method: "DELETE", token: user.token });
    expect((await remove()).status).toBe(204);
    expect((await remove()).status).toBe(204);
    const deleted = await askSync(true, initial.cursor);
    expect(await deleted.json()).toMatchObject({ savedPages: [{ id: page.id, deleted: true }] });
    expect(await (await askSync(true)).json()).toMatchObject({ savedPages: [] });
    now = new Date("2026-12-03T00:00:00Z");
    expect(await runCleanUp(platform)).toMatchObject({ savedPages: 1 });
    const expired = await askSync(true, initial.cursor);
    expect(expired.status).toBe(400);
    expect(await expired.json()).toMatchObject({ error: { code: "invalid_cursor" } });
    expect((await askSync(false, initial.cursor)).status).toBe(200);

    const fresh = (await (await askSync(true)).json()) as { cursor: string };
    expect(await (await save()).json()).toMatchObject({
      page: { id: page.id, savedAt: now.toISOString() },
    });
    expect(await (await askSync(true, fresh.cursor)).json()).toMatchObject({
      savedPages: [{ id: page.id, url, deleted: false }],
    });
  });

  it("書き込みが並んでも人ごとの保存件数を超えない", async () => {
    const user = await createUser();
    const { platform } = createTestPlatform();
    await env.DB.prepare(`
      with recursive n(i) as (select 1 union all select i + 1 from n where i < ?)
      insert into saved_pages (user_id, id, url, saved_at, seq)
      select ?, printf('%064x', i), 'https://example.com/' || i, 0, i from n
    `)
      .bind(SAVED_PAGE_LIMITS.active - 1, user.id)
      .run();
    const save = (name: string) =>
      requestApp(platform, "/api/v1/saved", {
        token: user.token,
        method: "PUT",
        json: { url: `https://test.example/${name}` },
      });
    const result = await Promise.all(["one", "two"].map(save));
    expect(result.map((r) => r.status).sort()).toEqual([200, 409]);
    const success = result.find((r) => r.ok);
    const kept = (await success?.json()) as { page: Page };
    const name = new URL(kept.page.url).pathname.slice(1);
    expect(await (await save(name)).json()).toEqual(kept);
  });
});
