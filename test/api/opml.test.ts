import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { runJob } from "../../src/jobs";
import { readOpml } from "../../src/opml";
import { FEEDLY_OPML } from "../fixtures/opml";
import { createTestPlatform, requestApp } from "../helpers";

type Json = Record<string, unknown>;

function postOpml(platform: Parameters<typeof requestApp>[0], body: string, headers = {}) {
  return requestApp(platform, "/api/v1/opml", {
    method: "POST",
    body,
    headers: { "content-type": "text/x-opml", ...headers },
  });
}

describe("OPML の API", () => {
  beforeEach(async () => {
    await env.DB.exec("DELETE FROM feeds");
    await env.DB.exec("DELETE FROM folders");
  });

  it("インポートを受け付け、ジョブを実行すると購読とフォルダが揃い、書き出せる", async () => {
    const { platform, enqueued } = createTestPlatform();

    const res = await postOpml(platform, FEEDLY_OPML);

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({
      accepted: 4,
      skippedCount: 3,
      skipped: [
        { url: "https://example.com/feed.xml", reason: "duplicate" },
        { url: "http://169.254.169.254/latest", reason: "url_not_allowed" },
        { url: "javascript:alert(1)", reason: "url_not_allowed" },
      ],
    });

    // キューに積まれたインポートのジョブを実行する（取得のジョブは外部に出るので実行しない）
    for (const job of [...enqueued]) {
      if (job.type === "import-feeds") await runJob(platform, job);
    }

    const folders = (await (await requestApp(platform, "/api/v1/folders")).json()) as {
      items: { id: string; name: string }[];
    };
    expect(folders.items.map((folder) => folder.name)).toEqual(["Tech", "セキュリティ"]);

    const feeds = (await (await requestApp(platform, "/api/v1/feeds")).json()) as {
      items: { url: string; folderId: string | null }[];
    };
    expect(feeds.items).toHaveLength(4);
    const tech = folders.items.find((folder) => folder.name === "Tech")?.id;
    expect(
      feeds.items.find((feed) => feed.url === "https://blog.cloudflare.com/rss/"),
    ).toMatchObject({ folderId: tech });

    const exported = await requestApp(platform, "/api/v1/opml");
    expect(exported.status).toBe(200);
    expect(exported.headers.get("content-type")).toContain("text/x-opml");
    expect(exported.headers.get("content-disposition")).toContain("attachment");
    expect(readOpml(await exported.text()).entries).toEqual(
      expect.arrayContaining([
        { url: "https://blog.cloudflare.com/rss/", folder: "Tech" },
        { url: "https://jvndb.jvn.jp/ja/rss/jvndb_new.rdf", folder: "セキュリティ" },
        { url: "https://top.example/atom.xml", folder: null },
      ]),
    );
  });

  it("フィードが多ければ、インポートのジョブを小分けにして積む", async () => {
    const { platform, enqueued } = createTestPlatform();
    const outlines = Array.from(
      { length: 60 },
      (_, i) => `<outline text="f" xmlUrl="https://f${i}.example/feed"/>`,
    ).join("");

    await postOpml(platform, `<opml version="2.0"><body>${outlines}</body></opml>`);

    const sizes = enqueued.map((job) => (job.type === "import-feeds" ? job.feeds.length : 0));
    expect(sizes).toEqual([10, 10, 10, 10, 10, 10]);
  });

  it("OPML でなければ 400", async () => {
    const { platform, enqueued } = createTestPlatform();
    const res = await postOpml(platform, "<html>nope</html>");

    expect(res.status).toBe(400);
    expect(((await res.json()) as Json).error).toMatchObject({ code: "invalid_opml" });
    expect(enqueued).toEqual([]);
  });

  it("大きすぎれば 413", async () => {
    const { platform } = createTestPlatform();
    const res = await postOpml(platform, "x".repeat(2 * 1024 * 1024 + 1));

    expect(res.status).toBe(413);
  });

  it("認証がなければ、インポートも書き出しもできない", async () => {
    const { platform } = createTestPlatform();

    expect(
      (await requestApp(platform, "/api/v1/opml", { method: "POST", body: "x", token: null }))
        .status,
    ).toBe(401);
    expect((await requestApp(platform, "/api/v1/opml", { token: null })).status).toBe(401);
  });
});
