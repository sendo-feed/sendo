import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { insertArticles } from "../../src/db/articles";
import { deliverNewArticles } from "../../src/db/inbox";
import { createTestPlatform, fakeFetch, requestApp, TEST_USER } from "../helpers";

type FeedJson = { id: string; url: string; title: string | null; folderId: string | null };

const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>Blog</title>
  <link>https://blog.example/</link><item><title>a</title><link>https://blog.example/a</link></item>
</channel></rss>`;

const HTML = `<!doctype html><html><head>
  <title>Blog</title>
  <link rel="stylesheet" href="/style.css">
  <link rel="alternate" type="application/rss+xml" title="Posts" href="/feed.xml?a=1&amp;b=2">
  <LINK REL="Alternate" TYPE="application/atom+xml" TITLE='Comments' HREF="https://blog.example/comments.atom">
  <link rel="alternate" type="text/html" hreflang="en" href="/en/">
</head><body>hi</body></html>`;

/** ブログのサイトを模した fetch。/ は HTML、/feed.xml は RSS、それ以外は 404 */
function blogSite() {
  return fakeFetch((url) => {
    if (url.pathname === "/")
      return new Response(HTML, { headers: { "content-type": "text/html" } });
    if (url.pathname === "/feed.xml") return new Response(RSS);
    return new Response("not found", { status: 404 });
  });
}

function subscribe(platform: Parameters<typeof requestApp>[0], json: unknown) {
  return requestApp(platform, "/api/v1/feeds", { method: "POST", json });
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM feeds");
  await env.DB.exec("DELETE FROM folders");
});

describe("POST /api/v1/feeds", () => {
  it("フィードの URL なら、取得して確かめてから登録し、取得をキューに積む", async () => {
    const { fetch, calls } = blogSite();
    const { platform, enqueued } = createTestPlatform({ fetch });

    const res = await subscribe(platform, { url: "https://blog.example/feed.xml" });

    expect(res.status).toBe(201);
    const { feed } = (await res.json()) as { feed: FeedJson };
    expect(feed).toMatchObject({
      url: "https://blog.example/feed.xml",
      title: "Blog",
      folderId: null,
    });
    expect(enqueued).toEqual([{ type: "fetch-feed", feedId: feed.id }]);
    expect(calls.map((call) => call.url)).toEqual(["https://blog.example/feed.xml"]);
  });

  it("サイトの URL なら、<link rel=alternate> から最初のフィードを見つけて登録する", async () => {
    const { fetch, calls } = blogSite();
    const { platform } = createTestPlatform({ fetch });

    const res = await subscribe(platform, { url: "https://blog.example/" });

    expect(res.status).toBe(201);
    expect(((await res.json()) as { feed: FeedJson }).feed.url).toBe(
      "https://blog.example/feed.xml?a=1&b=2",
    );
    expect(calls.map((call) => call.url)).toEqual([
      "https://blog.example/",
      "https://blog.example/feed.xml?a=1&b=2",
    ]);
  });

  it("最初の候補が読めなければ、次の候補を試す", async () => {
    const { fetch } = fakeFetch((url) => {
      if (url.pathname === "/")
        return new Response(
          `<link rel="alternate" type="application/rss+xml" href="/broken">
           <link rel="alternate" type="application/rss+xml" href="/feed.xml">`,
        );
      if (url.pathname === "/feed.xml") return new Response(RSS);
      return new Response("<html>not a feed</html>");
    });
    const { platform } = createTestPlatform({ fetch });

    const res = await subscribe(platform, { url: "https://blog.example/" });

    expect(((await res.json()) as { feed: FeedJson }).feed.url).toBe(
      "https://blog.example/feed.xml",
    );
  });

  it("フォルダを指定して購読できる", async () => {
    const { platform } = createTestPlatform({ fetch: blogSite().fetch });
    const folder = (await (
      await requestApp(platform, "/api/v1/folders", { method: "POST", json: { name: "Tech" } })
    ).json()) as { folder: { id: string } };

    const res = await subscribe(platform, {
      url: "https://blog.example/feed.xml",
      folderId: folder.folder.id,
    });

    expect(((await res.json()) as { feed: FeedJson }).feed.folderId).toBe(folder.folder.id);
  });

  it("同じ URL なら、取得せずに既存のフィードを返す", async () => {
    const { fetch, calls } = blogSite();
    const { platform, enqueued } = createTestPlatform({ fetch });
    const first = await (
      await subscribe(platform, { url: "https://blog.example/feed.xml" })
    ).json();
    calls.length = 0;

    // 大文字やフラグメントの違いは、正規化で同じ URL になる
    const res = await subscribe(platform, { url: "HTTPS://BLOG.example/feed.xml#top" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(first);
    expect(calls).toEqual([]);
    expect(enqueued).toHaveLength(1);
  });

  it("サイトの URL から見つけたフィードをすでに購読していれば、それを返す", async () => {
    const { platform } = createTestPlatform({ fetch: blogSite().fetch });
    await subscribe(platform, { url: "https://blog.example/feed.xml?a=1&b=2" });

    const res = await subscribe(platform, { url: "https://blog.example/" });

    expect(res.status).toBe(200);
  });

  it("フィードが見つからなければ 422（feed_not_found）", async () => {
    const { fetch } = fakeFetch(() => new Response("<html><head></head></html>"));
    const { platform, enqueued } = createTestPlatform({ fetch });

    const res = await subscribe(platform, { url: "https://nofeed.example/" });

    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: { code: "feed_not_found" } });
    expect(enqueued).toEqual([]);
  });

  it("取得できなければ 422（fetch_failed）", async () => {
    const { fetch } = fakeFetch(() => new Response("down", { status: 503 }));
    const { platform } = createTestPlatform({ fetch });

    const res = await subscribe(platform, { url: "https://down.example/feed" });

    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: { code: "fetch_failed" } });
  });

  it("ページの <link> が内部のホストを指していても、取得しない", async () => {
    const { fetch, calls } = fakeFetch(
      () =>
        new Response(
          '<link rel="alternate" type="application/rss+xml" href="http://169.254.169.254/feed">',
        ),
    );
    const { platform } = createTestPlatform({ fetch });

    const res = await subscribe(platform, { url: "https://evil.example/" });

    expect(res.status).toBe(422);
    expect(calls.map((call) => call.url)).toEqual(["https://evil.example/"]);
  });

  it.each([
    ["内部のホスト", { url: "http://169.254.169.254/latest/meta-data" }, "url_not_allowed"],
    [
      "存在しないフォルダ",
      { url: "https://blog.example/feed.xml", folderId: "nope" },
      "folder_not_found",
    ],
    ["url がない", {}, "invalid_request"],
    ["url が文字列でない", { url: 1 }, "invalid_request"],
  ])("%s なら 400", async (_label, body, code) => {
    const { platform, enqueued } = createTestPlatform({ fetch: blogSite().fetch });
    const res = await subscribe(platform, body);

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code } });
    expect(enqueued).toEqual([]);
  });
});

describe("GET /api/v1/feeds/discover", () => {
  it("サイトのフィードの候補を返す（購読はしない）", async () => {
    const { platform, enqueued } = createTestPlatform({ fetch: blogSite().fetch });

    const res = await requestApp(platform, "/api/v1/feeds/discover?url=https://blog.example/");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      candidates: [
        { url: "https://blog.example/feed.xml?a=1&b=2", title: "Posts" },
        { url: "https://blog.example/comments.atom", title: "Comments" },
      ],
    });
    expect(enqueued).toEqual([]);
  });

  it("URL そのものがフィードなら、それだけを返す", async () => {
    const { platform } = createTestPlatform({ fetch: blogSite().fetch });

    const res = await requestApp(
      platform,
      "/api/v1/feeds/discover?url=https://blog.example/feed.xml",
    );

    expect(await res.json()).toEqual({
      candidates: [{ url: "https://blog.example/feed.xml", title: "Blog" }],
    });
  });
});

describe("GET /api/v1/feeds", () => {
  it("購読したフィードを返す", async () => {
    const { platform } = createTestPlatform({ fetch: blogSite().fetch });
    await subscribe(platform, { url: "https://blog.example/feed.xml" });

    const res = await requestApp(platform, "/api/v1/feeds");

    expect(res.status).toBe(200);
    const { items } = (await res.json()) as { items: FeedJson[] };
    expect(items.map((feed) => feed.url)).toEqual(["https://blog.example/feed.xml"]);
  });
});

describe("PATCH ／ DELETE /api/v1/feeds/{id}", () => {
  async function setup() {
    const { platform } = createTestPlatform({ fetch: blogSite().fetch });
    const { feed } = (await (
      await subscribe(platform, { url: "https://blog.example/feed.xml" })
    ).json()) as { feed: FeedJson };
    return { platform, feed };
  }

  it("フォルダに移し、フォルダなしに戻せる", async () => {
    const { platform, feed } = await setup();
    const { folder } = (await (
      await requestApp(platform, "/api/v1/folders", { method: "POST", json: { name: "Tech" } })
    ).json()) as { folder: { id: string } };

    const moved = await requestApp(platform, `/api/v1/feeds/${feed.id}`, {
      method: "PATCH",
      json: { folderId: folder.id },
    });
    expect(((await moved.json()) as { feed: FeedJson }).feed.folderId).toBe(folder.id);

    const back = await requestApp(platform, `/api/v1/feeds/${feed.id}`, {
      method: "PATCH",
      json: { folderId: null },
    });
    expect(((await back.json()) as { feed: FeedJson }).feed.folderId).toBeNull();
  });

  it("存在しないフォルダやフィードなら 400 ／ 404", async () => {
    const { platform, feed } = await setup();

    const noFolder = await requestApp(platform, `/api/v1/feeds/${feed.id}`, {
      method: "PATCH",
      json: { folderId: "nope" },
    });
    expect(noFolder.status).toBe(400);

    const noFeed = await requestApp(platform, "/api/v1/feeds/nope", {
      method: "PATCH",
      json: { folderId: null },
    });
    expect(noFeed.status).toBe(404);
  });

  it("購読をやめると、スターを付けた記事を除いて受信箱から消える。記事そのものは残る", async () => {
    const { platform, feed } = await setup();
    const past = new Date(Date.now() - 1000);
    await insertArticles(
      platform.db,
      ["kept", "gone"].map((id) => ({
        id,
        feedId: feed.id,
        guid: id,
        url: null,
        title: id,
        summary: null,
        author: null,
        publishedAt: past,
        createdAt: past,
      })),
    );
    await deliverNewArticles(platform.db, { feedId: feed.id });
    await requestApp(platform, "/api/v1/articles/kept", {
      method: "PATCH",
      json: { starred: true },
    });

    const res = await requestApp(platform, `/api/v1/feeds/${feed.id}`, { method: "DELETE" });

    expect(res.status).toBe(204);
    const inbox = await env.DB.prepare(
      "SELECT article_id FROM user_articles WHERE user_id = ? AND feed_id = ?",
    )
      .bind(TEST_USER.id, feed.id)
      .all<{ article_id: string }>();
    expect(inbox.results.map((row) => row.article_id)).toEqual(["kept"]);
    const articles = await env.DB.prepare("SELECT count(*) AS n FROM articles WHERE feed_id = ?")
      .bind(feed.id)
      .first<{ n: number }>();
    expect(articles?.n).toBe(2);
    expect((await requestApp(platform, "/api/v1/feeds")).status).toBe(200);
    expect(
      (await requestApp(platform, `/api/v1/feeds/${feed.id}`, { method: "DELETE" })).status,
    ).toBe(404);
  });

  it("購読をやめたフィードを、もう一度購読できる", async () => {
    const { platform, feed } = await setup();
    await requestApp(platform, `/api/v1/feeds/${feed.id}`, { method: "DELETE" });

    const res = await subscribe(platform, { url: feed.url });

    expect(res.status).toBe(201);
    expect(((await res.json()) as { feed: FeedJson }).feed.id).toBe(feed.id);
  });
});

describe("フォルダの API", () => {
  async function create(platform: Parameters<typeof requestApp>[0], name: string) {
    return requestApp(platform, "/api/v1/folders", { method: "POST", json: { name } });
  }

  it("作って、名前を変えて、一覧に出る", async () => {
    const { platform } = createTestPlatform();
    const created = await create(platform, "  Tech   News ");
    expect(created.status).toBe(201);
    const { folder } = (await created.json()) as { folder: { id: string; name: string } };
    expect(folder.name).toBe("Tech News");

    const renamed = await requestApp(platform, `/api/v1/folders/${folder.id}`, {
      method: "PATCH",
      json: { name: "技術" },
    });
    expect(renamed.status).toBe(200);

    const list = (await (await requestApp(platform, "/api/v1/folders")).json()) as {
      items: { name: string }[];
    };
    expect(list.items.map((item) => item.name)).toEqual(["技術"]);
  });

  it("同じ名前は 409、空の名前は 400", async () => {
    const { platform } = createTestPlatform();
    await create(platform, "Tech");
    const other = (await (await create(platform, "News")).json()) as { folder: { id: string } };

    expect((await create(platform, "Tech")).status).toBe(409);
    expect(
      (
        await requestApp(platform, `/api/v1/folders/${other.folder.id}`, {
          method: "PATCH",
          json: { name: "Tech" },
        })
      ).status,
    ).toBe(409);
    expect((await create(platform, "   ")).status).toBe(400);
  });

  it("同じ名前への変更（変わらない）は 200", async () => {
    const { platform } = createTestPlatform();
    const { folder } = (await (await create(platform, "Tech")).json()) as {
      folder: { id: string };
    };

    const res = await requestApp(platform, `/api/v1/folders/${folder.id}`, {
      method: "PATCH",
      json: { name: "Tech" },
    });

    expect(res.status).toBe(200);
  });

  it("フォルダを消すと、入っていたフィードはフォルダなしに戻る", async () => {
    const { platform } = createTestPlatform({ fetch: blogSite().fetch });
    const { folder } = (await (await create(platform, "Tech")).json()) as {
      folder: { id: string };
    };
    const { feed } = (await (
      await subscribe(platform, { url: "https://blog.example/feed.xml", folderId: folder.id })
    ).json()) as { feed: FeedJson };

    const res = await requestApp(platform, `/api/v1/folders/${folder.id}`, { method: "DELETE" });

    expect(res.status).toBe(204);
    const feeds = (await (await requestApp(platform, "/api/v1/feeds")).json()) as {
      items: FeedJson[];
    };
    expect(feeds.items.find((item) => item.id === feed.id)?.folderId).toBeNull();
    expect(
      (await requestApp(platform, `/api/v1/folders/${folder.id}`, { method: "DELETE" })).status,
    ).toBe(404);
  });
});
