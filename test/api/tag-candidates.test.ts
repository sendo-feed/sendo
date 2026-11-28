import { describe, expect, it } from "vitest";
import { insertFeed } from "../../src/db/feeds";
import { MAX_TAG_REJECTIONS } from "../../src/db/tag-candidates";
import { runJob } from "../../src/jobs";
import { runFetchFeed } from "../../src/jobs/fetch-feed";
import type { AnalysisCandidate, ArticleAnalysisInput, Platform } from "../../src/platform";
import { testDb } from "../db";
import {
  createTestPlatform,
  createUser,
  fakeArticleAnalysis,
  fakeFetch,
  requestApp,
  statementHook,
  uniqueUrl,
} from "../helpers";

/*
 * タグの候補の一覧と却下（docs/decisions/tags.md の 1〜3、6）。記事は取得の仕事で入れ、候補は解析の仕事で
 * 作る（本番と同じ道）。解析の差し替えは、記事のタイトルごとに決めた候補を返す
 */

type Candidate = { key: string; label: string; count: number };
type Item = {
  title: string;
  published?: string;
  candidates: [string, string, ("text" | "category")?][];
};

const rss = (
  items: Item[],
) => `<rss version="2.0"><channel><title>Blog</title><link>https://example.com/</link>
  ${items
    .map(
      (item, i) =>
        `<item><title>${item.title}</title><guid isPermaLink="false">g${i}</guid><pubDate>${item.published ?? new Date().toUTCString()}</pubDate></item>`,
    )
    .join("")}
</channel></rss>`;

/** フィードごとの記事の並び。キーはフィードの URL */
async function setup() {
  const byTitle = new Map<string, AnalysisCandidate[]>();
  const feeds = new Map<string, Item[]>();
  const { fetch } = fakeFetch((url) => new Response(rss(feeds.get(url.href) ?? [])));
  const articleAnalysis = fakeArticleAnalysis();
  articleAnalysis.analyze.mockImplementation(async (input: ArticleAnalysisInput) => ({
    candidates: byTitle.get(input.title) ?? [],
    embedding: null,
  }));
  const { platform, enqueued } = createTestPlatform({ fetch, articleAnalysis });
  const user = await createUser();
  const c = client(platform, user.token);
  /** フィードを購読して取り込み、解析する */
  const feed = async (items: Item[], who = c) => {
    const url = uniqueUrl();
    feeds.set(url, items);
    for (const item of items) {
      byTitle.set(
        item.title,
        item.candidates.map(([surface, key, source]) => ({
          surface,
          key,
          source: source ?? "text",
        })),
      );
    }
    const response = await who.request("/feeds", "POST", { url });
    expect(response.status).toBe(201);
    const id = ((await response.json()) as { feed: { id: string } }).feed.id;
    await runFetchFeed(platform, id);
    for (let job = enqueued.shift(); job; job = enqueued.shift()) {
      if (job.type === "analyze-articles") await runJob(platform, job);
    }
    return { id, url };
  };
  return { ...c, platform, user, feed, articleAnalysis };
}

function client(platform: Platform, token: string) {
  const request = (path: string, method = "GET", json?: unknown) =>
    requestApp(platform, `/api/v1${path}`, { method, json, token });
  const candidates = async () => {
    const response = await request("/tags/candidates");
    expect(response.status).toBe(200);
    return (await response.json()) as { items: Candidate[]; pending: number };
  };
  const reject = (key: string) => request("/tags/rejections", "POST", { key });
  const restore = (key: string) => request("/tags/rejections/restore", "POST", { key });
  return { request, candidates, reject, restore };
}

const article = (title: string, ...candidates: Item["candidates"]): Item => ({ title, candidates });

describe("候補の一覧", () => {
  it("鍵ごとに記事の数を数えて多い順（同じ数なら鍵の順）に返し、見出しはいちばん多い表記", async () => {
    const t = await setup();
    await t.feed([
      article("a1", ["Kubernetes", "kubernetes"], ["Go", "go"]),
      article("a2", ["KUBERNETES", "kubernetes"], ["Rust", "rust"]),
      article("a3", ["Kubernetes", "kubernetes"], ["AWS", "aws"]),
    ]);
    const { items, pending } = await t.candidates();
    expect(items).toEqual([
      { key: "kubernetes", label: "Kubernetes", count: 3 },
      { key: "aws", label: "AWS", count: 1 },
      { key: "go", label: "Go", count: 1 },
      { key: "rust", label: "Rust", count: 1 },
    ]);
    expect(pending).toBe(0);
  });

  it("受信箱に入った時刻と公開日時のどちらも 30 日以内の記事だけで数える", async () => {
    const t = await setup();
    await t.feed([
      article("new", ["Rust", "rust"]),
      {
        title: "migrated",
        published: "Mon, 01 Apr 2013 00:00:00 GMT",
        candidates: [["Old", "old"]],
      },
      article("received-long-ago", ["Late", "late"]),
    ]);
    // 受信箱に入った時刻が 30 日より前の記事にする
    await testDb
      .prepare(
        "UPDATE user_articles SET created_at = created_at - 31 * 86400000 WHERE user_id = ? AND article_id = (SELECT id FROM articles WHERE title = 'received-long-ago')",
      )
      .bind(t.user.id)
      .run();
    expect((await t.candidates()).items.map((item) => item.key)).toEqual(["rust"]);
  });

  it("同じフィードの解析済みの記事の 50% 以上に出る記事の文字の語は、そのフィードの記事からは数えない（10 件以上のフィードだけ）", async () => {
    const t = await setup();
    // 10 件のフィード：share は 5 件（50% ちょうど）で外れ、topic は 4 件で残る。カテゴリの tag は全件でも残る
    await t.feed(
      Array.from({ length: 10 }, (_, i) =>
        article(
          `big${i}`,
          ...([
            ...(i < 5 ? [["Share", "share"]] : []),
            ...(i < 4 ? [["Topic", "topic"]] : []),
            ["Tag", "tag", "category"],
          ] as Item["candidates"]),
        ),
      ),
    );
    // 9 件のフィード：全件に出ても外さない
    await t.feed(Array.from({ length: 9 }, (_, i) => article(`small${i}`, ["Footer", "footer"])));
    // ほかのフィードの share は数える
    await t.feed([article("other", ["Share", "share"])]);
    expect(await t.candidates()).toEqual({
      items: [
        { key: "tag", label: "Tag", count: 10 },
        { key: "footer", label: "Footer", count: 9 },
        { key: "topic", label: "Topic", count: 4 },
        { key: "share", label: "Share", count: 1 },
      ],
      pending: 0,
    });
  });

  it("定型の語として外した行は見出しの数からも外し、分母には候補のない解析済みの記事も入る", async () => {
    const t = await setup();
    // 10 件のフィードの 5 件に出る SHARE は外れる。見出しは、ほかのフィードの 1 件の Share になる
    await t.feed(
      Array.from({ length: 10 }, (_, i) =>
        article(`label${i}`, ...((i < 5 ? [["SHARE", "share"]] : []) as Item["candidates"])),
      ),
    );
    await t.feed([article("label-other", ["Share", "share"])]);
    // 14 件のフィード（うち 4 件は候補なし）の 6 件に出る語は 6/14 で残る（分母が候補のある 10 件なら外れる）
    await t.feed(
      Array.from({ length: 14 }, (_, i) =>
        article(
          `denominator${i}`,
          ...((i < 6
            ? [["Topic", "topic"]]
            : i < 10
              ? [["Other", `other${i}`]]
              : []) as Item["candidates"]),
        ),
      ),
    );
    const { items } = await t.candidates();
    expect(items.find((item) => item.key === "share")).toEqual({
      key: "share",
      label: "Share",
      count: 1,
    });
    expect(items.find((item) => item.key === "topic")).toEqual({
      key: "topic",
      label: "Topic",
      count: 6,
    });
  });

  it("100 件の境目で同じ数の鍵は鍵の順で切り、見出しが同じ数なら表記のコードポイントの順で先のもの", async () => {
    const t = await setup();
    const keys = Array.from({ length: 101 }, (_, i) => `k${String(i).padStart(3, "0")}`);
    await t.feed([
      article("many", ...keys.map((key) => [key.toUpperCase(), key] as [string, string])),
      article("tie-a", ["Go", "go"]),
      article("tie-b", ["GO", "go"]),
    ]);
    const { items } = await t.candidates();
    expect(items).toHaveLength(100);
    expect(items[0]).toEqual({ key: "go", label: "GO", count: 2 });
    expect(items.at(-1)?.key).toBe("k098");
  });

  it("世代の合う候補の行だけを数え、まだ今の版で解析していない記事の数を pending に返す", async () => {
    const t = await setup();
    await t.feed([article("a1", ["Rust", "rust"]), article("a2", ["Go", "go"])]);
    // 世代の合わない候補の行（印を書く前に落ちた解析の分）
    await testDb.exec(`INSERT INTO article_candidates (article_id, generation, key, surface, source, created_at)
      SELECT id, 'stale', 'stale', 'Stale', 'text', 0 FROM articles WHERE title = 'a1'`);
    expect((await t.candidates()).items.map((item) => item.key)).toEqual(["go", "rust"]);
    t.articleAnalysis.candidateRevision = 2;
    expect((await t.candidates()).pending).toBe(2);
  });

  it("すでにタグにした語と却下した語は外し、見出しを name に送ってタグを作ると候補から外れる", async () => {
    const t = await setup();
    await t.feed([article("a1", ["Kubernetes", "kubernetes"], ["Go", "go"], ["Docker", "docker"])]);
    const [first] = (await t.candidates()).items;
    expect(first?.key).toBe("docker");
    expect((await t.request("/tags", "POST", { name: first?.label })).status).toBe(201);
    expect((await t.reject("GO")).status).toBe(200);
    expect((await t.candidates()).items.map((item) => item.key)).toEqual(["kubernetes"]);
    // 却下を戻すと、また出る
    expect(await (await t.restore("go")).json()).toEqual({ restored: true });
    expect((await t.candidates()).items.map((item) => item.key)).toEqual(["go", "kubernetes"]);
  });

  it("ほかの人の受信箱は数えない", async () => {
    const owner = await setup();
    const other = client(owner.platform, (await createUser()).token);
    await owner.feed([article("theirs", ["Secret", "secret"])], other);
    await owner.feed([article("mine", ["Rust", "rust"])]);
    expect((await owner.candidates()).items.map((item) => item.key)).toEqual(["rust"]);
    expect((await other.candidates()).items.map((item) => item.key)).toEqual(["secret"]);
  });
});

describe("却下", () => {
  it("鍵はまとめの鍵の形にそろえて 2〜40 コードポイントで確かめ、合わなければ invalid_key", async () => {
    const t = await setup();
    expect(await (await t.reject("  ＲＵＳＴ  ")).json()).toEqual({ created: true });
    expect(await (await t.reject("rust")).json()).toEqual({ created: false });
    expect(await (await t.reject("あ".repeat(40))).json()).toEqual({ created: true });
    for (const key of ["r", " r ", "あ".repeat(41), "a\u0007b", "\ud800ab"]) {
      const response = await t.reject(key);
      expect(response.status, key).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "invalid_key" } });
    }
    const list = await t.request("/tags/rejections");
    const items = ((await list.json()) as { items: { key: string }[] }).items;
    expect(items.map((item) => item.key).sort()).toEqual(["rust", "あ".repeat(40)].sort());
  });

  it("戻すときは 2〜40 の決まりを当てず、保存した鍵のままでも正規化し直した形でも照らす。ない語も成功", async () => {
    const t = await setup();
    // 鍵の作り方が変わる前に保存した鍵（今の作り方では作れない形）をまねる
    await testDb
      .prepare("INSERT INTO tag_rejections (user_id, key, rejected_at) VALUES (?, ?, 0)")
      .bind(t.user.id, "Old Key")
      .run();
    expect(await (await t.restore("Old Key")).json()).toEqual({ restored: true });
    expect((await t.reject("Kubernetes")).status).toBe(200);
    expect(await (await t.restore("KUBERNETES")).json()).toEqual({ restored: true });
    expect(await (await t.restore("x")).json()).toEqual({ restored: false });
    expect((await t.restore("あ".repeat(200))).status).toBe(200);
    for (const key of ["あ".repeat(201), "a\u0007b"]) {
      const response = await t.restore(key);
      expect(response.status, key).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "invalid_key" } });
    }
  });

  it(`却下は 1 人 ${MAX_TAG_REJECTIONS} 語ちょうどまで受け、超えると 409。却下済みの語は上限でも成功`, async () => {
    const t = await setup();
    // 999 語を直接入れる（作るのに手間がかかるため）
    const values = Array.from(
      { length: MAX_TAG_REJECTIONS - 1 },
      (_, i) => `('${t.user.id}', 'word${i}', ${i})`,
    ).join(",");
    await testDb.exec(`INSERT INTO tag_rejections (user_id, key, rejected_at) VALUES ${values}`);
    expect(await (await t.reject("last")).json()).toEqual({ created: true });
    const over = await t.reject("over");
    expect(over.status).toBe(409);
    expect(await over.json()).toMatchObject({ error: { code: "tag_rejection_limit_reached" } });
    expect(await (await t.reject("word0")).json()).toEqual({ created: false });
    // ほかの人の却下は数えない
    const other = client(t.platform, (await createUser()).token);
    expect(await (await other.reject("over")).json()).toEqual({ created: true });
  });
});

describe("却下の重なり", () => {
  it("却下が入らず、読み直す前に同じ語が戻されたら、流し直して却下する（上限でなくても 409 にしない）", async () => {
    const t = await setup();
    expect((await t.reject("rust")).status).toBe(200);
    const hook = statementHook(/as existing/i, async () => {
      await t.restore("rust");
    });
    const hooked = client({ ...t.platform, db: hook.db }, t.user.token);
    const response = await hooked.reject("rust");
    expect(hook.fired()).toBe(true);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ created: true });
  });
});

describe("集計の時間", () => {
  it("見積もった実際の量（30 日で 18,000 件、候補 23 万行、60 フィード）でも、p95 で 1 秒を超えない", async () => {
    const t = await setup();
    await t.feed([article("seed", ["Seed", "seed"])]);
    // 実際の量に近いデータを直接入れる（作るのに手間がかかるため）。1 日約 600 件、記事あたり 13 個、
    // 鍵は 5,000 種類。フィードは受信箱の行の側で 60 個に分け、各フィードに定型の語を 1 つ置く
    const now = Date.now();
    const feeds = Array.from({ length: 60 }, (_, i) => `perf-feed-${i}`);
    for (const id of feeds) {
      await insertFeed(t.platform.db, { id, url: `https://perf.example/${id}`, now: new Date() });
    }
    const rows = {
      articles: [] as string[],
      inbox: [] as string[],
      analyses: [] as string[],
      candidates: [] as string[],
    };
    for (let i = 0; i < 18_000; i++) {
      const id = `perf${i}`;
      const feed = feeds[i % feeds.length];
      const at = now - (i % 29) * 86_400_000;
      rows.articles.push(`('${id}', '${feed}', '${id}', ${at}, ${at})`);
      rows.inbox.push(`('${t.user.id}', '${id}', '${feed}', ${at}, ${at}, ${1_000_000 + i})`);
      rows.analyses.push(`('${id}', '${feed}', 1, 'done', 'g', 1, 'empty', ${at})`);
      rows.candidates.push(`('${id}', 'g', 'boiler-${i % feeds.length}', 'Boiler', 'text', ${at})`);
      for (let k = 0; k < 12; k++) {
        const key = `w${(i * 7 + k * 131) % 5000}`;
        rows.candidates.push(`('${id}', 'g', '${key}', '${key}', 'text', ${at})`);
      }
    }
    const insert = async (head: string, values: string[]) => {
      for (let i = 0; i < values.length; i += 1_000) {
        await testDb.exec(`${head} VALUES ${values.slice(i, i + 1_000).join(",")}`);
      }
    };
    await insert(
      "INSERT INTO articles (id, feed_id, guid, published_at, created_at)",
      rows.articles,
    );
    await insert(
      "INSERT INTO user_articles (user_id, article_id, feed_id, published_at, created_at, seq)",
      rows.inbox,
    );
    await insert(
      "INSERT INTO article_analyses (article_id, feed_id, candidate_revision, candidate_status, candidate_generation, embedding_revision, embedding_status, analyzed_at)",
      rows.analyses,
    );
    await insert(
      "INSERT INTO article_candidates (article_id, generation, key, surface, source, created_at)",
      rows.candidates,
    );
    const times: number[] = [];
    for (let i = 0; i < 20; i++) {
      const started = performance.now();
      const { items } = await t.candidates();
      times.push(performance.now() - started);
      expect(items).toHaveLength(100);
      // 定型の語は外れる
      expect(items.some((item) => item.key.startsWith("boiler-"))).toBe(false);
    }
    times.sort((a, b) => a - b);
    expect(times[Math.ceil(times.length * 0.95) - 1]).toBeLessThan(1_000);
  }, 120_000);
});
