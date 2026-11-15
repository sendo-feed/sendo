import { describe, expect, it } from "vitest";
import { FetchImageError, fetchImage, sniffImageType } from "../../src/fetcher/fetch-image";
import { AVIF, GIF, HTML, ICO, JPEG, PNG, SVG, WEBP } from "../fixtures/images";
import { fakeFetch } from "../helpers";

const URL_ = "https://img.example.com/a.png";

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof FetchImageError) return error.code;
    throw error;
  }
  return "no error";
}

describe("sniffImageType", () => {
  it("通す形式を、先頭のバイトで見分ける", () => {
    expect(sniffImageType(JPEG)).toBe("image/jpeg");
    expect(sniffImageType(PNG)).toBe("image/png");
    expect(sniffImageType(GIF)).toBe("image/gif");
    expect(sniffImageType(WEBP)).toBe("image/webp");
    expect(sniffImageType(AVIF)).toBe("image/avif");
    expect(sniffImageType(ICO)).toBe("image/x-icon");
  });

  it("SVG、HTML、空、短すぎるものは通さない", () => {
    expect(sniffImageType(SVG)).toBeNull();
    expect(sniffImageType(HTML)).toBeNull();
    expect(sniffImageType(new Uint8Array())).toBeNull();
    expect(sniffImageType(new Uint8Array([0xff, 0xd8]))).toBeNull();
    // ICO の印だけで、画像の数が 0 のもの
    expect(sniffImageType(new Uint8Array([0, 0, 1, 0, 0, 0, 0, 0]))).toBeNull();
  });
});

describe("fetchImage", () => {
  it("画像を取得し、形式は配信元の Content-Type ではなく中身で決める", async () => {
    const { fetch } = fakeFetch(
      () => new Response(PNG, { headers: { "content-type": "text/html" } }),
    );
    const image = await fetchImage(URL_, { fetch });
    expect(image.contentType).toBe("image/png");
    expect(await readAll(image.body)).toEqual(PNG);
  });

  it("配信元には、Sendo の User-Agent と Accept だけを送る", async () => {
    const { fetch, calls } = fakeFetch(() => new Response(PNG));
    const image = await fetchImage(URL_, { fetch });
    await image.body.cancel();
    expect([...(calls[0]?.headers.keys() ?? [])].sort()).toEqual(["accept", "user-agent"]);
    expect(calls[0]?.headers.get("user-agent")).toMatch(/^Sendo\//);
  });

  it("画像でないもの（Content-Type を画像と偽った HTML、SVG）は断る", async () => {
    for (const body of [HTML, SVG]) {
      const { fetch } = fakeFetch(
        () => new Response(body, { headers: { "content-type": "image/png" } }),
      );
      expect(await codeOf(fetchImage(URL_, { fetch }))).toBe("not_an_image");
    }
  });

  it("内部の宛先は、取得せずに断る", async () => {
    const { fetch, calls } = fakeFetch(() => new Response(PNG));
    for (const url of [
      "http://127.0.0.1/a.png",
      "http://169.254.169.254/latest/meta-data",
      "http://localhost/a.png",
      "ftp://img.example.com/a.png",
      "https://user:pass@img.example.com/a.png",
    ]) {
      expect(await codeOf(fetchImage(url, { fetch }))).toBe("blocked_url");
    }
    expect(calls).toHaveLength(0);
  });

  it("リダイレクトの行き先も確かめ、内部の宛先なら断る", async () => {
    const { fetch, calls } = fakeFetch(
      () => new Response(null, { status: 302, headers: { location: "http://10.0.0.1/a.png" } }),
    );
    expect(await codeOf(fetchImage(URL_, { fetch }))).toBe("blocked_url");
    expect(calls).toHaveLength(1);
  });

  it("リダイレクトをたどる。多すぎれば断る", async () => {
    const hop = fakeFetch((url) =>
      url.pathname === "/a.png"
        ? new Response(null, { status: 301, headers: { location: "/b.png" } })
        : new Response(PNG),
    );
    const image = await fetchImage(URL_, { fetch: hop.fetch });
    await image.body.cancel();
    expect(hop.calls.map((call) => call.url)).toEqual([URL_, "https://img.example.com/b.png"]);

    const loop = fakeFetch(
      () => new Response(null, { status: 302, headers: { location: "/again" } }),
    );
    expect(await codeOf(fetchImage(URL_, { fetch: loop.fetch, maxRedirects: 2 }))).toBe(
      "too_many_redirects",
    );
  });

  it("200 でなければ断る", async () => {
    const { fetch } = fakeFetch(() => new Response(PNG, { status: 404 }));
    expect(await codeOf(fetchImage(URL_, { fetch }))).toBe("http_status");
  });

  it("Content-Length が上限を超えていれば、読まずに断る", async () => {
    const { fetch } = fakeFetch(
      () => new Response(PNG, { headers: { "content-length": "999999" } }),
    );
    expect(await codeOf(fetchImage(URL_, { fetch, maxBytes: 1000 }))).toBe("too_large");
  });

  it("Content-Length がなくても、読んだ量が上限を超えたら途中で止める", async () => {
    const chunk = new Uint8Array(600);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(PNG);
        controller.enqueue(chunk);
        controller.enqueue(chunk);
        controller.close();
      },
    });
    const { fetch } = fakeFetch(() => new Response(body));
    const image = await fetchImage(URL_, { fetch, maxBytes: 1000 });
    expect(await codeOf(readAll(image.body))).toBe("too_large");
  });

  it("圧縮して送られた本体には、Content-Length を付けない", async () => {
    const plain = fakeFetch(() => new Response(PNG, { headers: { "content-length": "64" } }));
    const a = await fetchImage(URL_, { fetch: plain.fetch });
    await a.body.cancel();
    expect(a.contentLength).toBe(64);

    const encoded = fakeFetch(
      () => new Response(PNG, { headers: { "content-length": "40", "content-encoding": "br" } }),
    );
    const b = await fetchImage(URL_, { fetch: encoded.fetch });
    await b.body.cancel();
    expect(b.contentLength).toBeNull();
  });
});
