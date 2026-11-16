import { eq, inArray } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { QUERY_BUDGET } from "../../src/db/chunk";
import { CONTENT_NOTE_GRACE_MS, noteContentKeys } from "../../src/db/content";
import { articles, contentNotes } from "../../src/db/schema";
import { runCleanUp } from "../../src/jobs/clean-up";
import { MAX_CONTENT_BYTES, MAX_CONTENTS_PER_FETCH, runFetchFeed } from "../../src/jobs/fetch-feed";
import type { ObjectStore } from "../../src/platform";
import { createTestPlatform, createUser, fakeFetch, requestApp, subscribeFeed } from "../helpers";

/*
 * 記事の本文（docs/decisions/content.md）。フィードに入っている本文を、取り込むときに置き場に置き、
 * 記事ごとに配る。
 */

const LONG = "長い本文です。".repeat(100);

const item = (guid: string, body: string) =>
  `<item><title>${guid}</title><link>https://blog.example/${guid}</link><guid>${guid}</guid>${body}</item>`;
const rss = (...items: string[]) =>
  `<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel>
    <title>Blog</title><link>https://blog.example/</link>${items.join("")}</channel></rss>`;
const encoded = (html: string) => `<content:encoded><![CDATA[${html}]]></content:encoded>`;

const FULL = encoded(
  `<p onclick="x()">${LONG}</p><script>alert(1)</script><p><img src="/img/a.png" alt="図"><a href="/next">次へ</a></p>`,
);

/** 置き場への操作を数える */
function countingStore(store: ObjectStore) {
  const puts: string[] = [];
  const deletes: string[] = [];
  const wrapped: ObjectStore = {
    async put(key, text) {
      puts.push(key);
      await store.put(key, text);
    },
    get: (key) => store.get(key),
    async delete(keys) {
      deletes.push(...keys);
      await store.delete(keys);
    },
  };
  return { store: wrapped, puts, deletes };
}

async function setUp(feedBody: () => string) {
  const user = await createUser();
  let now = new Date();
  const base = createTestPlatform();
  const counting = countingStore(base.platform.content);
  const { platform } = createTestPlatform({
    fetch: fakeFetch((url) =>
      url.hostname === "blog.example"
        ? new Response(null, { status: 404 })
        : new Response(feedBody()),
    ).fetch,
    now: () => now,
    content: counting.store,
  });
  const feed = await subscribeFeed(platform, { userId: user.id });
  const rows = () => platform.db.select().from(articles).where(eq(articles.feedId, feed.id)).all();
  const byGuid = async (guid: string) => {
    const row = (await rows()).find((r) => r.guid === guid);
    if (!row) throw new Error(`no article: ${guid}`);
    return row;
  };
  const notes = (keys: string[]) =>
    platform.db.select().from(contentNotes).where(inArray(contentNotes.key, keys)).all();
  return {
    platform,
    user,
    feed,
    rows,
    byGuid,
    notes,
    puts: counting.puts,
    deletes: counting.deletes,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
}

describe("本文を取り込む", () => {
  it("フィードの本文をサニタイズして置き、記事の行に名前を入れる。要約と同じ中身なら置かない", async () => {
    const t = await setUp(() =>
      rss(
        item("full", FULL),
        item("short", "<description>短い説明</description>"),
        item("none", ""),
      ),
    );

    await runFetchFeed(t.platform, t.feed.id);

    const full = await t.byGuid("full");
    expect(full.contentKey).toMatch(/^feed\/[0-9a-f]{32}$/);
    expect((await t.byGuid("short")).contentKey).toBeNull();
    expect((await t.byGuid("none")).contentKey).toBeNull();

    const stored = await t.platform.content.get(full.contentKey ?? "");
    expect(stored).toBe(
      `<p>${LONG}</p><p><img src="https://blog.example/img/a.png" alt="図"><a href="https://blog.example/next" rel="noopener noreferrer nofollow">次へ</a></p>`,
    );
    // 行に入った名前の書き留めは、残らない
    expect(t.puts).toEqual([full.contentKey]);
    expect(await t.notes(t.puts)).toEqual([]);
  });

  it("短い本文でも、要約と中身が違えば置く（要約が別の欄から採られている場合）", async () => {
    const t = await setUp(() =>
      rss(
        item(
          "differs",
          `<description>短い紹介文</description>${encoded("<p>紹介文にない、短い本文</p>")}`,
        ),
        item("same", `<description>同じ文</description>${encoded("<p>同じ文</p>")}`),
      ),
    );

    await runFetchFeed(t.platform, t.feed.id);

    const differs = await t.byGuid("differs");
    expect(differs.summary).toBe("短い紹介文");
    expect(await t.platform.content.get(differs.contentKey ?? "")).toBe(
      "<p>紹介文にない、短い本文</p>",
    );
    expect((await t.byGuid("same")).contentKey).toBeNull();
  });

  it("短くても、画像やリンクのある本文は置く", async () => {
    const t = await setUp(() => rss(item("img", encoded('<p>図<img src="/a.png"></p>'))));

    await runFetchFeed(t.platform, t.feed.id);

    expect((await t.byGuid("img")).contentKey).not.toBeNull();
  });

  it("Atom の content と JSON Feed の content_html も置く", async () => {
    let body = `<feed xmlns="http://www.w3.org/2005/Atom"><title>A</title>
      <entry><id>urn:a</id><title>a</title><link href="https://blog.example/a"/>
      <summary>要約</summary><content type="html">&lt;p&gt;${LONG}&lt;/p&gt;</content></entry></feed>`;
    const t = await setUp(() => body);
    await runFetchFeed(t.platform, t.feed.id);
    const atom = await t.byGuid("urn:a");
    expect(await t.platform.content.get(atom.contentKey ?? "")).toBe(`<p>${LONG}</p>`);

    body = JSON.stringify({
      version: "https://jsonfeed.org/version/1.1",
      title: "J",
      items: [{ id: "j1", url: "https://blog.example/j1", content_html: `<p>${LONG}</p>` }],
    });
    await runFetchFeed(t.platform, t.feed.id);
    const json = await t.byGuid("j1");
    expect(await t.platform.content.get(json.contentKey ?? "")).toBe(`<p>${LONG}</p>`);
  });

  it("すでにある記事の本文は、もう一度置かない", async () => {
    const t = await setUp(() => rss(item("full", FULL)));
    await runFetchFeed(t.platform, t.feed.id);
    const before = await t.byGuid("full");

    await runFetchFeed(t.platform, t.feed.id);

    expect(t.puts).toHaveLength(1);
    expect((await t.byGuid("full")).contentKey).toBe(before.contentKey);
  });

  it("1 回の取得で置くのは上限の数まで。超えた分は、本文なしで取り込む", async () => {
    const guids = Array.from({ length: MAX_CONTENTS_PER_FETCH + 5 }, (_, i) => `g${i}`);
    const t = await setUp(() => rss(...guids.map((guid) => item(guid, FULL))));

    await runFetchFeed(t.platform, t.feed.id);

    const rows = await t.rows();
    expect(rows).toHaveLength(guids.length);
    expect(rows.filter((row) => row.contentKey !== null)).toHaveLength(MAX_CONTENTS_PER_FETCH);
    expect(t.puts).toHaveLength(MAX_CONTENTS_PER_FETCH);
  });

  it("本文を上限の数まで置く取得でも、D1 のクエリは上限に収まる", async () => {
    const guids = Array.from({ length: MAX_CONTENTS_PER_FETCH + 5 }, (_, i) => `g${i}`);
    const user = await createUser();
    const { platform, queryCount, resetQueryCount } = createTestPlatform({
      fetch: fakeFetch((url) =>
        url.hostname === "blog.example"
          ? new Response(null, { status: 404 })
          : new Response(rss(...guids.map((guid) => item(guid, FULL)))),
      ).fetch,
    });
    const feed = await subscribeFeed(platform, { userId: user.id });

    resetQueryCount();
    await runFetchFeed(platform, feed.id);

    expect(queryCount()).toBeLessThanOrEqual(QUERY_BUDGET);
  });

  it("大きすぎる本文は置かない", async () => {
    const t = await setUp(() =>
      rss(item("big", encoded(`<p>${"x".repeat(MAX_CONTENT_BYTES)}</p>`))),
    );

    await runFetchFeed(t.platform, t.feed.id);

    expect((await t.byGuid("big")).contentKey).toBeNull();
    expect(t.puts).toEqual([]);
  });

  it("本文を置いたあとで落ちたら、書き留めが残り、やり直しは新しい名前で置き直す", async () => {
    const t = await setUp(() => rss(item("full", FULL)));
    const failing = {
      ...t.platform,
      // 記事の行を入れる文だけを失敗させる
      db: new Proxy(t.platform.db, {
        get(target, prop, receiver) {
          if (prop === "insert") {
            return (table: unknown) => {
              if (table === articles) throw new Error("boom");
              return target.insert(table as typeof articles);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      }),
    };

    await expect(runFetchFeed(failing, t.feed.id)).rejects.toThrow("boom");

    // 本文は置かれ、行はなく、書き留めが残っている
    expect(t.puts).toHaveLength(1);
    const [orphan = ""] = t.puts;
    expect(await t.rows()).toEqual([]);
    expect(await t.notes([orphan])).toHaveLength(1);

    // やり直すと、新しい名前で置き直して行が入る
    await runFetchFeed(t.platform, t.feed.id);
    const key = (await t.byGuid("full")).contentKey ?? "";
    expect(key).not.toBe(orphan);
    expect(await t.platform.content.get(key)).not.toBeNull();

    // 1 時間たつまでは、残った本文を消さない
    expect((await runCleanUp(t.platform)).contents).toBe(0);
    expect(await t.platform.content.get(orphan)).not.toBeNull();

    // 1 時間たったら、行のない本文だけを消す
    t.advance(CONTENT_NOTE_GRACE_MS + 60_000);
    await runCleanUp(t.platform);
    expect(t.deletes).toEqual([orphan]);
    expect(await t.platform.content.get(orphan)).toBeNull();
    expect(await t.platform.content.get(key)).not.toBeNull();
    expect(await t.notes([orphan])).toEqual([]);
  });
});

describe("本文を片付ける", () => {
  it("記事の行が消えると、トリガーが名前を書き留め、片付けが本文を消す", async () => {
    const t = await setUp(() => rss(item("full", FULL), item("keep", FULL)));
    await runFetchFeed(t.platform, t.feed.id);
    const gone = (await t.byGuid("full")).contentKey ?? "";
    const kept = (await t.byGuid("keep")).contentKey ?? "";

    await t.platform.db.delete(articles).where(eq(articles.contentKey, gone)).run();

    expect(await t.notes([gone, kept])).toEqual([expect.objectContaining({ key: gone })]);
    // 記事を消す処理は、置き場に触らない
    expect(await t.platform.content.get(gone)).not.toBeNull();

    t.advance(CONTENT_NOTE_GRACE_MS + 60_000);
    await runCleanUp(t.platform);

    expect(await t.platform.content.get(gone)).toBeNull();
    expect(await t.platform.content.get(kept)).not.toBeNull();
    expect(await t.notes([gone])).toEqual([]);
  });

  it("書き留めにあっても、記事の行に入っている名前の本文は消さない", async () => {
    const t = await setUp(() => rss(item("full", FULL)));
    await runFetchFeed(t.platform, t.feed.id);
    const key = (await t.byGuid("full")).contentKey ?? "";
    await noteContentKeys(t.platform.db, [key]);

    t.advance(CONTENT_NOTE_GRACE_MS + 60_000);
    await runCleanUp(t.platform);

    expect(await t.platform.content.get(key)).not.toBeNull();
    expect(t.deletes).not.toContain(key);
    expect(await t.notes([key])).toEqual([]);
  });
});

describe("本文の書き留めと、記事の削除の競合", () => {
  it("行に入っていると読んだあとで記事が消えても、書き留めは残り、次の片付けで本文を消す", async () => {
    const t = await setUp(() => rss(item("full", FULL)));
    await runFetchFeed(t.platform, t.feed.id);
    const key = (await t.byGuid("full")).contentKey ?? "";
    // 記事の行を入れたあと、書き留めを消す前に落ちた状態（記事と書き留めの両方がある）
    await noteContentKeys(t.platform.db, [key]);
    t.advance(CONTENT_NOTE_GRACE_MS + 60_000);

    // 片付けが書き留めを読んだあと、消す前に、記事が消える
    let deleted = false;
    const racing = {
      ...t.platform,
      content: {
        ...t.platform.content,
        async delete(keys: readonly string[]) {
          if (!deleted) {
            deleted = true;
            await t.platform.db.delete(articles).where(eq(articles.contentKey, key)).run();
          }
          await t.platform.content.delete(keys);
        },
      },
    };
    await runCleanUp(racing);

    // 本文はまだ消えていないが、書き留めが残っているので、手掛かりは失われない
    expect(await t.platform.content.get(key)).not.toBeNull();
    expect(await t.notes([key])).toHaveLength(1);

    await runCleanUp(t.platform);
    expect(await t.platform.content.get(key)).toBeNull();
    expect(await t.notes([key])).toEqual([]);
  });
});

describe("本文を配る", () => {
  type Article = { id: string; title: string; hasContent: boolean };

  it("記事に hasContent を載せ、本文を、画像を中継の URL に書き換えて返す", async () => {
    const t = await setUp(() => rss(item("full", FULL), item("none", "")));
    await runFetchFeed(t.platform, t.feed.id);
    const { token } = t.user;

    const list = await requestApp(t.platform, "/api/v1/articles", { token });
    const items = ((await list.json()) as { items: Article[] }).items;
    expect(items.map((a) => [a.title, a.hasContent]).sort()).toEqual([
      ["full", true],
      ["none", false],
    ]);
    // 置き場の名前は、API に出さない
    expect(JSON.stringify(items)).not.toContain("feed/");

    const sync = await requestApp(t.platform, "/api/v1/sync", { token });
    const synced = ((await sync.json()) as { articles: Article[] }).articles;
    expect(synced.find((a) => a.title === "full")?.hasContent).toBe(true);
    expect(synced.find((a) => a.title === "none")?.hasContent).toBe(false);

    const full = items.find((a) => a.title === "full");
    const res = await requestApp(t.platform, `/api/v1/articles/${full?.id}/content`, { token });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { html: string; source: string };
    expect(body.source).toBe("feed");
    expect(body.html).toContain(`<p>${LONG}</p>`);
    expect(body.html).not.toContain("script");
    expect(body.html).not.toContain("onclick");
    // 画像は中継の URL、リンクはもとの絶対の URL
    expect(body.html).toMatch(
      /<img src="\/api\/v1\/images\?url=https%3A%2F%2Fblog\.example%2Fimg%2Fa\.png&amp;sig=[\w-]{22}" alt="図">/,
    );
    expect(body.html).toContain(
      '<a href="https://blog.example/next" rel="noopener noreferrer nofollow">',
    );

    // 返した画像の URL は、そのまま中継の入口で通る（署名が合う）
    const src = /<img src="([^"]+)"/.exec(body.html)?.[1]?.replaceAll("&amp;", "&") ?? "";
    const image = await requestApp(t.platform, src, { token });
    expect(image.status).not.toBe(403);
  });

  it("本文のない記事、ほかの人の記事、ない記事は 404。認証がなければ 401", async () => {
    const t = await setUp(() => rss(item("full", FULL), item("none", "")));
    await runFetchFeed(t.platform, t.feed.id);
    const full = await t.byGuid("full");
    const none = await t.byGuid("none");
    const code = async (res: Response) =>
      ((await res.json()) as { error: { code: string } }).error.code;

    const noContent = await requestApp(t.platform, `/api/v1/articles/${none.id}/content`, {
      token: t.user.token,
    });
    expect(noContent.status).toBe(404);
    expect(await code(noContent)).toBe("no_content");

    // 購読していない人には、記事があることも分からない
    const other = await createUser();
    const others = await requestApp(t.platform, `/api/v1/articles/${full.id}/content`, {
      token: other.token,
    });
    expect(others.status).toBe(404);
    expect(await code(others)).toBe("not_found");

    const missing = await requestApp(t.platform, "/api/v1/articles/nope/content", {
      token: t.user.token,
    });
    expect(missing.status).toBe(404);

    const anonymous = await requestApp(t.platform, `/api/v1/articles/${full.id}/content`, {
      token: null,
    });
    expect(anonymous.status).toBe(401);
  });

  it("置き場に本文がなければ（片付けの途中など）、本文なしとして返す", async () => {
    const t = await setUp(() => rss(item("full", FULL)));
    await runFetchFeed(t.platform, t.feed.id);
    const full = await t.byGuid("full");
    await t.platform.content.delete([full.contentKey ?? ""]);

    const res = await requestApp(t.platform, `/api/v1/articles/${full.id}/content`, {
      token: t.user.token,
    });

    expect(res.status).toBe(404);
  });

  it("保存してある本文にも、返すときに今のサニタイズの決まりを当てる", async () => {
    const t = await setUp(() => rss(item("full", FULL)));
    await runFetchFeed(t.platform, t.feed.id);
    const full = await t.byGuid("full");
    // 古い決まりで保存された（今は通さない中身の入った）本文を置く
    await t.platform.content.put(
      full.contentKey ?? "",
      '<p>本文</p><script>alert(1)</script><a href="javascript:alert(1)">x</a><img src="x" onerror="alert(1)">',
    );

    const res = await requestApp(t.platform, `/api/v1/articles/${full.id}/content`, {
      token: t.user.token,
    });

    expect(((await res.json()) as { html: string }).html).toBe("<p>本文</p>x");
  });
});
