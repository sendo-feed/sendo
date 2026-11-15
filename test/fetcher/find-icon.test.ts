import { describe, expect, it } from "vitest";
import { findFeedIcon, findIconLinks } from "../../src/fetcher/find-icon";
import { HTML, ICO, PNG, SVG } from "../fixtures/images";
import { fakeFetch } from "../helpers";

const SITE = "https://blog.example.com/";

describe("findIconLinks", () => {
  it("apple-touch-icon を先に、icon をそのあとに返す。相対 URL はページから解決する", () => {
    expect(
      findIconLinks(
        `<head>
          <link rel="shortcut icon" href="/favicon-32.png">
          <link rel="stylesheet" href="/style.css">
          <link rel="apple-touch-icon" sizes="180x180" href="touch.png">
        </head>`,
        "https://blog.example.com/posts/",
      ),
    ).toEqual([
      "https://blog.example.com/posts/touch.png",
      "https://blog.example.com/favicon-32.png",
    ]);
  });

  it("SVG と分かるものは除く", () => {
    expect(
      findIconLinks(
        `<link rel="icon" type="image/svg+xml" href="/a">
         <link rel="icon" href="/icon.svg?v=2">
         <link rel="icon" href="/icon.png">`,
        SITE,
      ),
    ).toEqual(["https://blog.example.com/icon.png"]);
  });

  it("<base href> を基準にし、コメントや script の中は読まない", () => {
    expect(
      findIconLinks(
        `<!-- <link rel="icon" href="/commented.png"> -->
         <script>'<link rel="icon" href="/script.png">'</script>
         <link rel="icon" href="i.png"><base href="https://cdn.example.com/assets/">`,
        SITE,
      ),
    ).toEqual(["https://cdn.example.com/assets/i.png"]);
  });

  it("http ／ https でない href は捨てる", () => {
    expect(findIconLinks(`<link rel="icon" href="data:image/png;base64,AAAA">`, SITE)).toEqual([]);
  });
});

describe("findFeedIcon", () => {
  const find = (
    respond: Parameters<typeof fakeFetch>[0],
    input: Partial<Parameters<typeof findFeedIcon>[0]> = {},
  ) => {
    const fake = fakeFetch(respond);
    return {
      calls: fake.calls,
      result: findFeedIcon({
        fetch: fake.fetch,
        feedIconUrl: null,
        siteUrl: SITE,
        currentIconUrl: null,
        ...input,
      }),
    };
  };

  it("フィード自身のアイコンが画像なら、サイトは見にいかない", async () => {
    const { result, calls } = find(() => new Response(PNG), {
      feedIconUrl: "https://blog.example.com/feed-icon.png",
    });
    expect(await result).toBe("https://blog.example.com/feed-icon.png");
    expect(calls.map((call) => call.url)).toEqual(["https://blog.example.com/feed-icon.png"]);
  });

  it("サイトのページの <link> から探し、画像と確かめられたものを返す", async () => {
    const { result } = find((url) => {
      if (url.pathname === "/") return new Response(`<link rel="icon" href="/i.png">`);
      if (url.pathname === "/i.png") return new Response(PNG);
      return new Response(null, { status: 404 });
    });
    expect(await result).toBe("https://blog.example.com/i.png");
  });

  it("<link> の先が画像でなければ（HTML、SVG）、/favicon.ico を試す", async () => {
    const { result } = find((url) => {
      if (url.pathname === "/") {
        return new Response(`<link rel="icon" href="/a"><link rel="icon" href="/b">`);
      }
      if (url.pathname === "/a")
        return new Response(HTML, { headers: { "content-type": "image/png" } });
      if (url.pathname === "/b") return new Response(SVG);
      if (url.pathname === "/favicon.ico") return new Response(ICO);
      return new Response(null, { status: 404 });
    });
    expect(await result).toBe("https://blog.example.com/favicon.ico");
  });

  it("サイトのページが取れなくても、/favicon.ico を試す", async () => {
    const { result } = find((url) =>
      url.pathname === "/favicon.ico" ? new Response(ICO) : new Response(null, { status: 500 }),
    );
    expect(await result).toBe("https://blog.example.com/favicon.ico");
  });

  it("どれも画像でなければ null", async () => {
    const { result } = find(() => new Response(null, { status: 404 }));
    expect(await result).toBeNull();
  });

  it("サイトが分からなければ、フィード自身のアイコンだけを試す", async () => {
    const { result, calls } = find(() => new Response(null, { status: 404 }), { siteUrl: null });
    expect(await result).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("ほかの候補が取れないときは、今のアイコンがまだ画像なら残す", async () => {
    const current = "https://cdn.example.com/old.png";
    const { result } = find(
      (url) =>
        url.hostname === "cdn.example.com"
          ? new Response(PNG)
          : new Response(null, { status: 503 }),
      { currentIconUrl: current },
    );
    expect(await result).toBe(current);
  });

  it("内部の宛先を指す候補は、取得せずに飛ばす", async () => {
    const { result, calls } = find((url) => {
      if (url.pathname === "/")
        return new Response(`<link rel="icon" href="http://127.0.0.1/i.png">`);
      return new Response(null, { status: 404 });
    });
    expect(await result).toBeNull();
    expect(calls.some((call) => call.url.includes("127.0.0.1"))).toBe(false);
  });
});
