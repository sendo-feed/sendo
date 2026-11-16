import { afterEach, describe, expect, it, vi } from "vitest";
import { USER_AGENT } from "../../src/fetcher/fetch-feed";
import {
  fetchRobotsTxt,
  isAllowedByRules,
  normalizePath,
  parseRobotsTxt,
  ROBOTS_TTL_MS,
  ROBOTS_UNREACHABLE_TTL_MS,
  RobotsCache,
} from "../../src/fetcher/robots";
import { readPrefix } from "../../src/lib/read-limited";
import { fakeFetch } from "../helpers";

/*
 * robots.txt（RFC 9309、docs/decisions/content.md の 18）。例の多くは RFC 9309 の本文から採った。
 */

/** robots.txt を読み、path（パスとクエリ）を取りにいってよいかを返す */
function allowed(robotsTxt: string, path: string, token = "Sendo"): boolean {
  return isAllowedByRules(parseRobotsTxt(robotsTxt, token), new URL(path, "https://example.com"));
}

describe("グループの選び方", () => {
  it("製品トークンが当たるグループを使い、* のグループは使わない", () => {
    const txt = "User-agent: *\nDisallow: /\n\nUser-agent: Sendo\nDisallow: /private\n";
    expect(allowed(txt, "/public")).toBe(true);
    expect(allowed(txt, "/private/a")).toBe(false);
  });

  it("当たるグループがなければ * のグループを使う", () => {
    const txt = "User-agent: OtherBot\nDisallow: /\n\nUser-agent: *\nDisallow: /tmp\n";
    expect(allowed(txt, "/tmp/a")).toBe(false);
    expect(allowed(txt, "/a")).toBe(true);
  });

  it("どのグループも当たらなければ、すべて許可", () => {
    expect(allowed("User-agent: OtherBot\nDisallow: /\n", "/a")).toBe(true);
  });

  it("製品トークンは大文字と小文字を区別しない。バージョンなどの後ろの部分は見ない", () => {
    expect(allowed("User-agent: sendo\nDisallow: /\n", "/a")).toBe(false);
    expect(allowed("User-agent: SENDO/1.0\nDisallow: /\n", "/a")).toBe(false);
    expect(allowed("User-agent: Sendo-Extra\nDisallow: /\n", "/a")).toBe(true);
    expect(allowed("User-agent: Sendoo\nDisallow: /\n", "/a")).toBe(true);
    expect(allowed("User-agent: MySendo\nDisallow: /\n", "/a")).toBe(true);
  });

  it("当たるグループが複数あれば、まとめて 1 つにする", () => {
    const txt = [
      "User-agent: Sendo",
      "Disallow: /a",
      "",
      "User-agent: *",
      "Disallow: /c",
      "",
      "User-agent: Sendo",
      "Disallow: /b",
    ].join("\n");
    expect(allowed(txt, "/a")).toBe(false);
    expect(allowed(txt, "/b")).toBe(false);
    expect(allowed(txt, "/c")).toBe(true);
  });

  it("* のグループが複数あれば、まとめて 1 つにする", () => {
    const txt = "User-agent: *\nDisallow: /a\n\nUser-agent: *\nDisallow: /b\n";
    expect(allowed(txt, "/a")).toBe(false);
    expect(allowed(txt, "/b")).toBe(false);
  });

  it("続けて書いた User-agent の行は、1 つのグループになる", () => {
    const txt = "User-agent: OtherBot\nUser-agent: Sendo\nDisallow: /x\n";
    expect(allowed(txt, "/x")).toBe(false);
  });

  it("規則のあとの User-agent の行から、次のグループになる", () => {
    const txt = "User-agent: Sendo\nDisallow: /x\nUser-agent: OtherBot\nDisallow: /y\n";
    expect(allowed(txt, "/x")).toBe(false);
    expect(allowed(txt, "/y")).toBe(true);
  });

  it("当たるグループが空の Disallow だけなら、* のグループが断っていても許可", () => {
    const txt = "User-agent: *\nDisallow: /\n\nUser-agent: Sendo\nDisallow:\n";
    expect(allowed(txt, "/a")).toBe(true);
  });

  it("User-agent の行より前の規則は読まない", () => {
    expect(allowed("Disallow: /\nUser-agent: *\nDisallow: /x\n", "/a")).toBe(true);
  });

  it("知らない行（Sitemap、Crawl-delay）は読まず、グループも切らない", () => {
    const txt = [
      "Sitemap: https://example.com/sitemap.xml",
      "User-agent: OtherBot",
      "Crawl-delay: 10",
      "User-agent: Sendo",
      "Disallow: /x",
    ].join("\n");
    expect(allowed(txt, "/x")).toBe(false);
  });

  it("キーの大文字と小文字、前後の空白、コメント、CRLF と CR を受ける", () => {
    const txt = "\uFEFFuser-AGENT :  Sendo  # me\r\n  DISALLOW:/x # no\r\nAllow: /x/ok\r";
    expect(allowed(txt, "/x/a")).toBe(false);
    expect(allowed(txt, "/x/ok")).toBe(true);
    expect(allowed(txt, "/y")).toBe(true);
  });

  it("コロンのない行や、HTML のような中身は読み飛ばす", () => {
    expect(allowed("<html><body>not robots</body></html>\nfoo bar\n", "/a")).toBe(true);
  });
});

describe("照合", () => {
  it("どの規則にも当たらなければ許可", () => {
    expect(allowed("User-agent: *\nDisallow: /x\n", "/y")).toBe(true);
  });

  it("規則は先頭からの一致", () => {
    const txt = "User-agent: *\nDisallow: /fish\n";
    expect(allowed(txt, "/fish")).toBe(false);
    expect(allowed(txt, "/fish.html")).toBe(false);
    expect(allowed(txt, "/fish/salmon.html")).toBe(false);
    expect(allowed(txt, "/fishheads?id=1")).toBe(false);
    expect(allowed(txt, "/Fish.asp")).toBe(true);
    expect(allowed(txt, "/catfish")).toBe(true);
    expect(allowed(txt, "/?id=fish")).toBe(true);
  });

  it("いちばん長く一致した規則を使う", () => {
    const txt = "User-agent: *\nAllow: /example/page/\nDisallow: /example/page/disallowed.gif\n";
    expect(allowed(txt, "/example/page/")).toBe(true);
    expect(allowed(txt, "/example/page/disallowed.gif")).toBe(false);
    expect(allowed(txt, "/example/page/other.gif")).toBe(true);
  });

  it("書いた順ではなく長さで決める", () => {
    const txt = "User-agent: *\nDisallow: /a/b\nAllow: /a\n";
    expect(allowed(txt, "/a/b/c")).toBe(false);
    expect(allowed(txt, "/a/c")).toBe(true);
  });

  it("Allow と Disallow が同じ長さなら Allow", () => {
    expect(allowed("User-agent: *\nDisallow: /page\nAllow: /page\n", "/page")).toBe(true);
    expect(allowed("User-agent: *\nAllow: /page\nDisallow: /page\n", "/page")).toBe(true);
    expect(allowed("User-agent: *\nDisallow: /*.php\nAllow: /a.php$\n", "/a.php")).toBe(true);
  });

  it("* は任意の文字の並びに当たる", () => {
    const txt = "User-agent: *\nDisallow: /*.php\n";
    expect(allowed(txt, "/index.php")).toBe(false);
    expect(allowed(txt, "/filename.php")).toBe(false);
    expect(allowed(txt, "/folder/filename.php")).toBe(false);
    expect(allowed(txt, "/folder/filename.php?parameters")).toBe(false);
    expect(allowed(txt, "/folder/any.php.file.html")).toBe(false);
    expect(allowed(txt, "/filename.php/")).toBe(false);
    expect(allowed(txt, "/")).toBe(true);
    expect(allowed(txt, "/windows.PHP")).toBe(true);
  });

  it("末尾の $ は URL の終わりに当たる", () => {
    const txt = "User-agent: *\nDisallow: /*.php$\n";
    expect(allowed(txt, "/filename.php")).toBe(false);
    expect(allowed(txt, "/folder/filename.php")).toBe(false);
    expect(allowed(txt, "/filename.php?parameters")).toBe(true);
    expect(allowed(txt, "/filename.php/")).toBe(true);
    expect(allowed(txt, "/filename.php5")).toBe(true);
  });

  it("$ だけのパターンは、それ自身の URL にだけ当たる", () => {
    const txt = "User-agent: *\nDisallow: /$\n";
    expect(allowed(txt, "/")).toBe(false);
    expect(allowed(txt, "/a")).toBe(true);
  });

  it("途中の $ は、ふつうの文字として扱う", () => {
    const txt = "User-agent: *\nDisallow: /a$b\n";
    expect(allowed(txt, "/a$b/c")).toBe(false);
    expect(allowed(txt, "/a")).toBe(true);
  });

  it("* が続いても、* だけでも当たる", () => {
    expect(allowed("User-agent: *\nDisallow: /**/x\n", "/a/b/x")).toBe(false);
    expect(allowed("User-agent: *\nDisallow: *\n", "/anything")).toBe(false);
    expect(allowed("User-agent: *\nDisallow: /a*b*c$\n", "/aXbYc")).toBe(false);
    expect(allowed("User-agent: *\nDisallow: /a*b*c$\n", "/aXbYcZ")).toBe(true);
  });

  it("* がたくさんあっても、時間がかからない", () => {
    const txt = `User-agent: *\nDisallow: /${"*a".repeat(200)}$\n`;
    const started = Date.now();
    expect(allowed(txt, `/${"a".repeat(5000)}b`)).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("クエリも照合に含める", () => {
    const txt = "User-agent: *\nDisallow: /*?print=1\n";
    expect(allowed(txt, "/a?print=1")).toBe(false);
    expect(allowed(txt, "/a?print=0")).toBe(true);
  });

  it("Disallow: / はすべてを断る。Disallow が空なら何も断らない", () => {
    expect(allowed("User-agent: *\nDisallow: /\n", "/a")).toBe(false);
    expect(allowed("User-agent: *\nDisallow:\n", "/a")).toBe(true);
  });

  it("/robots.txt そのものは、いつも許可", () => {
    expect(allowed("User-agent: *\nDisallow: /\n", "/robots.txt")).toBe(true);
  });

  it("エンコードしなくてよい文字の %XX は、戻してから比べる", () => {
    expect(allowed("User-agent: *\nDisallow: /%7Efoo\n", "/~foo/bar")).toBe(false);
    expect(allowed("User-agent: *\nDisallow: /~foo\n", "/%7efoo/bar")).toBe(false);
    expect(allowed("User-agent: *\nDisallow: /%61bc\n", "/abc")).toBe(false);
  });

  it("区切りの文字の %XX は戻さない（/ と %2F は別のもの）", () => {
    expect(allowed("User-agent: *\nDisallow: /a%2Fb\n", "/a/b")).toBe(true);
    expect(allowed("User-agent: *\nDisallow: /a%2fb\n", "/a%2Fb")).toBe(false);
  });

  it("ASCII でない文字は、UTF-8 の %XX にして比べる", () => {
    expect(allowed("User-agent: *\nDisallow: /日本\n", "/日本/記事")).toBe(false);
    expect(allowed("User-agent: *\nDisallow: /%E6%97%A5%E6%9C%AC\n", "/日本")).toBe(false);
    expect(allowed("User-agent: *\nDisallow: /日本\n", "/%e6%97%a5%e6%9c%ac")).toBe(false);
    expect(allowed("User-agent: *\nDisallow: /日本\n", "/英語")).toBe(true);
  });

  it("URL に書けない ASCII（空白など）も、URL の側と同じようにエンコードして比べる", () => {
    expect(allowed('User-agent: *\nDisallow: /a"b\n', '/a"b')).toBe(false);
    expect(allowed("User-agent: *\nDisallow: /{x}\n", "/{x}")).toBe(false);
  });
});

describe("normalizePath", () => {
  it("そろえ方", () => {
    expect(normalizePath("/a%2fb%7E%41")).toBe("/a%2Fb~A");
    expect(normalizePath("/é")).toBe("/%C3%A9");
    expect(normalizePath("/😀")).toBe("/%F0%9F%98%80");
    expect(normalizePath("/a b")).toBe("/a%20b");
    expect(normalizePath("/100%")).toBe("/100%");
    expect(normalizePath("/*$")).toBe("/*$");
    expect(normalizePath("/\uD800")).toBe("/%EF%BF%BD");
  });
});

/** robots.txt だけを返す fetch。ほかの URL を取りにいったら失敗にする */
function robotsFetch(respond: (url: URL) => Response | Promise<Response>) {
  return fakeFetch((url) => {
    if (url.pathname !== "/robots.txt" && !url.pathname.startsWith("/r/")) {
      throw new Error(`unexpected fetch: ${url.href}`);
    }
    return respond(url);
  });
}

describe("fetchRobotsTxt", () => {
  it("2xx なら読む。User-Agent を付け、決めたヘッダーだけを送る", async () => {
    const { fetch, calls } = robotsFetch(() => new Response("User-agent: *\nDisallow: /x\n"));
    const result = await fetchRobotsTxt("https://example.com", { fetch });
    expect(result).toEqual({ status: "fetched", rules: [{ allow: false, pattern: "/x" }] });
    expect(calls.map((call) => call.url)).toEqual(["https://example.com/robots.txt"]);
    expect(calls[0]?.headers.get("user-agent")).toBe(USER_AGENT);
    expect(calls[0]?.headers.get("cookie")).toBeNull();
  });

  it("オリジンのポートを保つ", async () => {
    const { fetch, calls } = robotsFetch(() => new Response(""));
    await fetchRobotsTxt("https://example.com:8443", { fetch });
    expect(calls[0]?.url).toBe("https://example.com:8443/robots.txt");
  });

  it.each([400, 401, 403, 404, 410, 429, 451])("%i ならない（すべて許可）", async (status) => {
    const { fetch } = robotsFetch(() => new Response("User-agent: *\nDisallow: /", { status }));
    expect(await fetchRobotsTxt("https://example.com", { fetch })).toEqual({
      status: "unavailable",
    });
  });

  it.each([500, 502, 503, 504])("%i なら届かない（すべて不許可）", async (status) => {
    const { fetch } = robotsFetch(() => new Response("oops", { status }));
    expect(await fetchRobotsTxt("https://example.com", { fetch })).toMatchObject({
      status: "unreachable",
    });
  });

  it("接続できなければ届かない", async () => {
    const { fetch } = robotsFetch(() => {
      throw new TypeError("network down");
    });
    expect(await fetchRobotsTxt("https://example.com", { fetch })).toMatchObject({
      status: "unreachable",
    });
  });

  it("時間の上限を過ぎたら届かない", async () => {
    const { fetch } = robotsFetch(
      (url) =>
        new Promise<Response>((_, reject) => {
          // fetch の signal を見られないので、上限より後に失敗させる
          setTimeout(() => reject(new Error(`slow ${url.href}`)), 50);
        }),
    );
    expect(await fetchRobotsTxt("https://example.com", { fetch, timeoutMs: 10 })).toMatchObject({
      status: "unreachable",
      reason: expect.stringContaining("timed out"),
    });
  });

  it("リダイレクトをたどる（別のホストにも）", async () => {
    const { fetch, calls } = fakeFetch((url) =>
      url.host === "example.com"
        ? new Response(null, {
            status: 301,
            headers: { location: "https://cdn.example.net/robots.txt" },
          })
        : new Response("User-agent: *\nDisallow: /x\n"),
    );
    const result = await fetchRobotsTxt("https://example.com", { fetch });
    expect(result).toMatchObject({ status: "fetched" });
    expect(calls.map((call) => call.url)).toEqual([
      "https://example.com/robots.txt",
      "https://cdn.example.net/robots.txt",
    ]);
  });

  it("リダイレクトは 5 回までたどり、それを超えたらない（すべて許可）", async () => {
    const hops = (count: number) =>
      robotsFetch((url) => {
        const n = url.pathname === "/robots.txt" ? 0 : Number(url.pathname.slice(3));
        return n < count
          ? new Response(null, { status: 302, headers: { location: `/r/${n + 1}` } })
          : new Response("User-agent: *\nDisallow: /\n");
      });
    const five = hops(5);
    expect(await fetchRobotsTxt("https://example.com", { fetch: five.fetch })).toMatchObject({
      status: "fetched",
    });
    expect(five.calls).toHaveLength(6);

    const six = hops(6);
    expect(await fetchRobotsTxt("https://example.com", { fetch: six.fetch })).toEqual({
      status: "unavailable",
    });
    expect(six.calls).toHaveLength(6);
  });

  it("リダイレクトの行き先も SSRF の確認をかけ、内部向けなら取りにいかずに届かないとする", async () => {
    const { fetch, calls } = robotsFetch(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/latest/meta-data" },
        }),
    );
    expect(await fetchRobotsTxt("https://example.com", { fetch })).toMatchObject({
      status: "unreachable",
    });
    expect(calls).toHaveLength(1);
  });

  it("取りにいけないオリジン（内部向け）は、取りにいかずに届かないとする", async () => {
    const { fetch, calls } = fakeFetch(() => new Response(""));
    expect(await fetchRobotsTxt("http://localhost", { fetch })).toMatchObject({
      status: "unreachable",
    });
    expect(calls).toHaveLength(0);
  });

  it("Location のないリダイレクトは届かないとする", async () => {
    const { fetch } = robotsFetch(() => new Response(null, { status: 301 }));
    expect(await fetchRobotsTxt("https://example.com", { fetch })).toMatchObject({
      status: "unreachable",
    });
  });

  it("最初の maxBytes だけを読み、そこで切れた最後の行は捨てる", async () => {
    const head = "User-agent: *\nDisallow: /a\n";
    // 切れた行は「Disallow: /b」の途中（Disallow: /）で切れる。捨てなければ、すべてを断ってしまう
    const body = `${head}Disallow: /bbbbbbbb\n`;
    const { fetch } = robotsFetch(() => new Response(body));
    const result = await fetchRobotsTxt("https://example.com", {
      fetch,
      maxBytes: head.length + "Disallow: /".length,
    });
    expect(result).toEqual({ status: "fetched", rules: [{ allow: false, pattern: "/a" }] });
  });

  it("既定では 500KiB まで読む", async () => {
    const filler = `# ${"x".repeat(1021)}\n`.repeat(500); // 500KiB ちょうど
    const { fetch } = robotsFetch(() => new Response(`${filler}User-agent: *\nDisallow: /\n`));
    // 500KiB より後ろの規則は読まない
    expect(await fetchRobotsTxt("https://example.com", { fetch })).toEqual({
      status: "fetched",
      rules: [],
    });
  });
});

describe("readPrefix", () => {
  const stream = (...chunks: string[]) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    });
  const read = async (body: ReadableStream<Uint8Array> | null, max: number) => {
    const { bytes, truncated } = await readPrefix(body, max);
    return { text: new TextDecoder().decode(bytes), truncated };
  };

  it("上限までを読み、超えたかどうかを返す", async () => {
    expect(await read(stream("abc", "def"), 4)).toEqual({ text: "abcd", truncated: true });
    expect(await read(stream("abc", "def"), 6)).toEqual({ text: "abcdef", truncated: false });
    expect(await read(stream("abc", "def"), 3)).toEqual({ text: "abc", truncated: true });
    expect(await read(null, 3)).toEqual({ text: "", truncated: false });
  });
});

describe("RobotsCache", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const url = (path: string) => new URL(path, "https://example.com");

  it("オリジンごとに 1 回だけ取りにいき、24 時間置く", async () => {
    const { fetch, calls } = robotsFetch(() => new Response("User-agent: *\nDisallow: /x\n"));
    const cache = new RobotsCache();
    const now = new Date("2026-11-16T00:00:00Z");

    expect(await cache.isAllowed(url("/x"), { fetch, now })).toBe(false);
    expect(await cache.isAllowed(url("/y"), { fetch, now })).toBe(true);
    const almost = new Date(now.getTime() + ROBOTS_TTL_MS - 1);
    expect(await cache.isAllowed(url("/y"), { fetch, now: almost })).toBe(true);
    expect(calls).toHaveLength(1);

    const later = new Date(now.getTime() + ROBOTS_TTL_MS);
    await cache.isAllowed(url("/y"), { fetch, now: later });
    expect(calls).toHaveLength(2);
  });

  it("オリジン（スキーム、ホスト、ポート）が違えば、別に取りにいく", async () => {
    const { fetch, calls } = fakeFetch(() => new Response(""));
    const cache = new RobotsCache();
    const now = new Date();
    for (const origin of [
      "https://example.com",
      "http://example.com",
      "https://example.com:8443",
      "https://www.example.com",
    ]) {
      await cache.isAllowed(new URL("/a", origin), { fetch, now });
    }
    expect(calls.map((call) => call.url)).toEqual([
      "https://example.com/robots.txt",
      "http://example.com/robots.txt",
      "https://example.com:8443/robots.txt",
      "https://www.example.com/robots.txt",
    ]);
  });

  it("4xx ならすべて許可し、24 時間置く", async () => {
    const { fetch, calls } = robotsFetch(() => new Response("", { status: 404 }));
    const cache = new RobotsCache();
    const now = new Date();
    expect(await cache.isAllowed(url("/a"), { fetch, now })).toBe(true);
    const later = new Date(now.getTime() + ROBOTS_TTL_MS - 1);
    expect(await cache.isAllowed(url("/b"), { fetch, now: later })).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("届かなければすべて不許可にし、10 分だけ置く", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let status = 503;
    const { fetch, calls } = robotsFetch(() => new Response("", { status }));
    const cache = new RobotsCache();
    const now = new Date();
    expect(await cache.isAllowed(url("/a"), { fetch, now })).toBe(false);
    const soon = new Date(now.getTime() + ROBOTS_UNREACHABLE_TTL_MS - 1);
    expect(await cache.isAllowed(url("/a"), { fetch, now: soon })).toBe(false);
    expect(calls).toHaveLength(1);

    status = 200;
    const later = new Date(now.getTime() + ROBOTS_UNREACHABLE_TTL_MS);
    expect(await cache.isAllowed(url("/a"), { fetch, now: later })).toBe(true);
    expect(calls).toHaveLength(2);
    expect(warn).toHaveBeenCalledWith(
      "could not fetch robots.txt; treating as disallowed",
      expect.objectContaining({ origin: "https://example.com" }),
    );
  });

  it("同時に聞かれても、取りにいくのは 1 回", async () => {
    const { fetch, calls } = robotsFetch(() => new Response("User-agent: *\nDisallow: /x\n"));
    const cache = new RobotsCache();
    const now = new Date();
    const results = await Promise.all(
      ["/a", "/x", "/b"].map((path) => cache.isAllowed(url(path), { fetch, now })),
    );
    expect(results).toEqual([true, false, true]);
    expect(calls).toHaveLength(1);
  });

  it("/robots.txt そのものを聞かれたら、取りにいかずに許可", async () => {
    const { fetch, calls } = fakeFetch(() => new Response(""));
    const cache = new RobotsCache();
    expect(await cache.isAllowed(url("/robots.txt"), { fetch, now: new Date() })).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("置く数に上限があり、超えたら古いものから捨てる", async () => {
    const { fetch, calls } = fakeFetch(() => new Response(""));
    const cache = new RobotsCache({ maxEntries: 2 });
    const now = new Date();
    const ask = (host: string) => cache.isAllowed(new URL(`https://${host}/a`), { fetch, now });
    await ask("a.example");
    await ask("b.example");
    await ask("c.example"); // a を捨てる
    await ask("b.example");
    await ask("c.example");
    expect(calls).toHaveLength(3);
    await ask("a.example");
    expect(calls).toHaveLength(4);
  });
});
