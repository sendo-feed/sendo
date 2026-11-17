import { describe, expect, it, vi } from "vitest";
import { fetchImageOrPage } from "../../src/fetcher/fetch-image";
import { PAGE_IMAGE_LIMITS, resolvePageImages } from "../../src/fetcher/page-images";
import type { PageImageProcessor } from "../../src/platform";
import { fakeFetch } from "../helpers";

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0,
]);
const image = () => new Response(PNG, { headers: { "content-type": "image/png" } });
const html = (body = "<img src='./full.png'>") =>
  new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
const link = {
  thumbnail: "https://photos.example/thumb.png",
  target: "https://photos.example/view",
};
const body = `<p>before</p><a href="${link.target}"><img src="${link.thumbnail}"></a><p>after</p>`;
function processor(): PageImageProcessor {
  return {
    links: vi.fn(async () => [link]),
    candidates: vi.fn(async () => ["https://photos.example/full.png"]),
    compare: vi.fn(async (_thumb, candidate) => ({ eligible: true, matches: candidate !== null })),
    replace: vi.fn(async (html, link, full) => html.replace(link.thumbnail, full)),
  };
}
function options(fetch: typeof globalThis.fetch) {
  return {
    fetch,
    isAllowed: async () => true,
    run: async <T>(_url: string, task: () => Promise<T>) => task(),
  };
}

describe("本文の画像ページ", () => {
  it("HTML の相対 URL の基準にはリダイレクト後の URL を返す", async () => {
    const f = fakeFetch((url) =>
      url.pathname === "/view"
        ? new Response(null, { status: 302, headers: { location: "/photos/view.html" } })
        : html(),
    );
    const allowed: string[] = [];
    const result = await fetchImageOrPage(link.target, {
      fetch: f.fetch,
      isAllowed: async (url) => {
        allowed.push(url.href);
        return true;
      },
    });
    expect(result).toMatchObject({
      url: "https://photos.example/photos/view.html",
      contentType: "text/html; charset=utf-8",
    });
    expect(allowed).toEqual([link.target, "https://photos.example/photos/view.html"]);
  });

  it("robots 不許可のリダイレクト先とプライベート IP に取りにいかない", async () => {
    const f = fakeFetch(
      () =>
        new Response(null, { status: 302, headers: { location: "https://blocked.example/view" } }),
    );
    await expect(
      fetchImageOrPage(link.target, {
        fetch: f.fetch,
        isAllowed: async (u) => u.hostname !== "blocked.example",
      }),
    ).rejects.toMatchObject({ code: "robots_disallowed" });
    expect(f.calls).toHaveLength(1);
    await expect(
      fetchImageOrPage("http://127.0.0.1/view", { fetch: f.fetch }),
    ).rejects.toMatchObject({ code: "blocked_url" });
    expect(f.calls).toHaveLength(1);
  });

  it("HTML を 3MiB で止め、画像と偽った SVG も通さない", async () => {
    const f = fakeFetch(
      () =>
        new Response("", {
          headers: { "content-type": "text/html", "content-length": String(3 * 1024 * 1024 + 1) },
        }),
    );
    await expect(fetchImageOrPage(link.target, { fetch: f.fetch })).rejects.toThrow();
    const svg = fakeFetch(
      () =>
        new Response("<svg xmlns='http://www.w3.org/2000/svg'></svg>", {
          headers: { "content-type": "image/png" },
        }),
    );
    await expect(fetchImageOrPage(link.target, { fetch: svg.fetch })).rejects.toMatchObject({
      code: "not_an_image",
    });
  });

  it("一致した拡大画像だけを採り、元のリンクと段落の順番を保つ", async () => {
    const f = fakeFetch((u) => (u.pathname === "/view" ? html() : image()));
    const p = processor();
    const result = await resolvePageImages(body, "https://news.example/post", p, options(f.fetch));
    expect(result).toBe(body.replace(link.thumbnail, "https://photos.example/full.png"));
    expect(f.calls.map((c) => c.url)).toEqual([
      link.thumbnail,
      link.target,
      "https://photos.example/full.png",
    ]);
    expect(p.candidates).toHaveBeenCalledWith(
      expect.objectContaining({ url: link.target, contentType: "text/html; charset=utf-8" }),
    );
  });

  it("不一致・404・小さなアイコンでは、元の画像を残す", async () => {
    for (const mode of ["mismatch", "404", "small"]) {
      const p = processor();
      p.compare = vi.fn(async () => ({ eligible: mode !== "small", matches: false }));
      const f = fakeFetch((u) =>
        mode === "404" && u.pathname === "/view" ? new Response(null, { status: 404 }) : image(),
      );
      expect(await resolvePageImages(body, "https://news.example/post", p, options(f.fetch))).toBe(
        body,
      );
      if (mode === "small") expect(f.calls).toHaveLength(1);
      expect(p.replace).not.toHaveBeenCalled();
    }
  });

  it("リンクを再帰的にたどらず、外へのリクエストを 36 回に制限する", async () => {
    const p = processor();
    p.links = async () =>
      Array.from({ length: 40 }, (_, i) => ({
        thumbnail: `https://photos.example/thumb-${i}.png`,
        target: `https://photos.example/view-${i}`,
      }));
    p.candidates = async (input) => Array.from({ length: 10 }, (_, i) => `${input.url}-${i}.png`);
    p.compare = async () => ({ eligible: true, matches: false });
    const f = fakeFetch((u) =>
      u.pathname.endsWith(".png")
        ? image()
        : html("<a href='/next'>next</a><img src='/candidate.png'>"),
    );
    expect(await resolvePageImages(body, "https://news.example/post", p, options(f.fetch))).toBe(
      body,
    );
    expect(f.calls).toHaveLength(PAGE_IMAGE_LIMITS.requests);
    expect(f.calls.every((c) => !c.url.endsWith("/next"))).toBe(true);
  });

  it("画像と画像ページの本体を合計 25MiB で止める", async () => {
    const p = processor();
    p.links = async () =>
      Array.from({ length: 12 }, (_, i) => ({
        thumbnail: `https://photos.example/thumb-${i}.png`,
        target: `https://photos.example/full-${i}.png`,
      }));
    p.compare = async () => ({ eligible: true, matches: false });
    const bytes = new Uint8Array(PAGE_IMAGE_LIMITS.resourceBytes);
    bytes.set(PNG);
    const f = fakeFetch(() => new Response(bytes));
    expect(await resolvePageImages(body, "https://news.example/post", p, options(f.fetch))).toBe(
      body,
    );
    expect(f.calls).toHaveLength(5);
  });
  it("大きすぎて失敗した画像も合計の通信量に数える", async () => {
    const p = processor();
    p.links = async () =>
      Array.from({ length: 12 }, (_, i) => ({
        thumbnail: `https://photos.example/thumb-${i}.png`,
        target: `https://photos.example/full-${i}.png`,
      }));
    const bytes = new Uint8Array(PAGE_IMAGE_LIMITS.resourceBytes + 1);
    bytes.set(PNG);
    const f = fakeFetch(() => new Response(bytes));
    expect(await resolvePageImages(body, "https://news.example/post", p, options(f.fetch))).toBe(
      body,
    );
    expect(f.calls).toHaveLength(5);
  });
});
