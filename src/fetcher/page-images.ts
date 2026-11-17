/** 本文として残した画像のリンク先だけを、上限付きで 1 段調べる。 */
import { readLimited } from "../lib/read-limited";
import type { PageImageProcessor } from "../platform";
import type { FetchImageOptions } from "./fetch-image";
import { fetchImageOrPage } from "./fetch-image";

export const PAGE_IMAGE_LIMITS = {
  links: 12,
  requests: 36,
  bytes: 25 * 1024 * 1024,
  resourceBytes: 5 * 1024 * 1024,
  timeoutMs: 15_000,
} as const;

type Resource = {
  kind: "html" | "image";
  bytes: Uint8Array;
  url: string;
  contentType: string | null;
};

type Options = {
  fetch: typeof fetch;
  isAllowed: (url: URL, fetcher: typeof fetch) => Promise<boolean>;
  /** 記事ページと同じ HostGate に並ぶ。robots とリダイレクトもこの中で行う */
  run: <T>(url: string, task: () => Promise<T>) => Promise<T>;
};

export async function resolvePageImages(
  html: string,
  url: string,
  images: PageImageProcessor,
  options: Options,
): Promise<string> {
  const budget = new AbortController();
  const signal = AbortSignal.any([AbortSignal.timeout(PAGE_IMAGE_LIMITS.timeoutMs), budget.signal]);
  let remainingBytes: number = PAGE_IMAGE_LIMITS.bytes;
  let requests = 0;
  const fetched = new Map<string, Resource | null>();
  const fetcher: typeof fetch = (input, init) => {
    signal.throwIfAborted();
    if (++requests > PAGE_IMAGE_LIMITS.requests) {
      budget.abort();
      throw new Error("image request budget exceeded");
    }
    return options.fetch(input, {
      ...init,
      signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
    });
  };
  // 失敗した応答や上限を超えた応答のバイトも数える。robots.txt は別の上限で読む。
  const resourceFetch: typeof fetch = async (input, init) => {
    const response = await fetcher(input, init);
    if (!response.body) return response;
    const reader = response.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            return;
          }
          remainingBytes -= value.byteLength;
          if (remainingBytes < 0) {
            budget.abort();
            await reader.cancel();
            controller.error(new Error("image byte budget exceeded"));
            return;
          }
          controller.enqueue(value);
        } catch (error) {
          controller.error(error);
        }
      },
      cancel: () => reader.cancel(),
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
  async function resource(target: string): Promise<Resource | null> {
    if (fetched.has(target)) return fetched.get(target) ?? null;
    if (remainingBytes <= 0 || signal.aborted) return null;
    const result = await options.run(target, async () => {
      signal.throwIfAborted();
      const opts: FetchImageOptions = {
        fetch: resourceFetch,
        signal,
        maxBytes: Math.min(remainingBytes, PAGE_IMAGE_LIMITS.resourceBytes),
        isAllowed: (target) => options.isAllowed(target, fetcher),
      };
      const result = await fetchImageOrPage(target, opts);
      const bytes =
        "bytes" in result ? result.bytes : await readLimited(result.body, null, opts.maxBytes ?? 0);
      return {
        kind: "bytes" in result ? ("html" as const) : ("image" as const),
        bytes,
        url: "url" in result ? result.url : target,
        contentType: result.contentType,
      };
    });
    fetched.set(target, result);
    return result;
  }
  try {
    const links = (await images.links(html, url)).slice(0, PAGE_IMAGE_LIMITS.links);
    for (const link of links) {
      if (signal.aborted || requests >= PAGE_IMAGE_LIMITS.requests || remainingBytes <= 0) break;
      try {
        const thumbnail = await resource(link.thumbnail);
        if (thumbnail?.kind !== "image" || !(await images.compare(thumbnail.bytes, null)).eligible)
          continue;
        const target = await resource(link.target);
        if (!target) continue;
        const candidates =
          target.kind === "html" ? (await images.candidates(target)).slice(0, 3) : [link.target];
        for (const candidate of candidates) {
          const full = await resource(candidate);
          if (full?.kind !== "image") continue;
          if ((await images.compare(thumbnail.bytes, full.bytes)).matches) {
            html = await images.replace(html, link, candidate);
            break;
          }
        }
      } catch {
        // robots 不許可、404、予算切れ、デコード失敗などでも、元の画像とリンクを保つ。
      }
    }
  } catch {
    // 画像解析の失敗で、取得できた本文まで失わない。
  }
  return html;
}
