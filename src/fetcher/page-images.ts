/**
 * 本文として残した画像のリンク先だけを、上限付きで 1 段調べる（docs/decisions/content.md の 20）。
 * そのあとで、同じ上限の残りの中で、導入の画像があとの画像と同じ写真かを調べる（同じく 21）。
 */
import { readLimited } from "../lib/read-limited";
import type { PageImageProcessor } from "../platform";
import type { FetchImageOptions } from "./fetch-image";
import { fetchImageOrPage } from "./fetch-image";

export const PAGE_IMAGE_LIMITS = {
  links: 12,
  requests: 36,
  bytes: 25 * 1024 * 1024,
  resourceBytes: 5 * 1024 * 1024,
  timeoutMs: 45_000,
} as const;

type Resource = {
  kind: "html" | "image";
  bytes: Uint8Array;
  url: string;
  contentType: string | null;
};

/**
 * 記事 1 件で、外へ取りにいく回数・本体の大きさ・時間の上限（docs/decisions/content.md の 20）。
 * Imgur の投稿のページ（同じく 22）、拡大画像（20）、導入の画像（21）で 1 つを分け合う。
 * 期限は、作った時点から数える
 */
export type PageFetchBudget = {
  signal: AbortSignal;
  /** 回数だけを数える fetch（robots.txt の取得に使う。本体は 18 の上限で別に読む） */
  fetch: typeof fetch;
  /** 回数と本体の大きさを数える fetch。失敗した応答や上限を超えた応答のバイトも数える */
  resourceFetch: typeof fetch;
  remainingBytes(): number;
  /** 期限切れか、回数か大きさを使い切った */
  exhausted(): boolean;
};

export function createPageFetchBudget(baseFetch: typeof fetch): PageFetchBudget {
  const budget = new AbortController();
  const signal = AbortSignal.any([AbortSignal.timeout(PAGE_IMAGE_LIMITS.timeoutMs), budget.signal]);
  let remainingBytes: number = PAGE_IMAGE_LIMITS.bytes;
  let requests = 0;
  const fetcher: typeof fetch = (input, init) => {
    signal.throwIfAborted();
    if (++requests > PAGE_IMAGE_LIMITS.requests) {
      budget.abort();
      throw new Error("image request budget exceeded");
    }
    return baseFetch(input, {
      ...init,
      signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
    });
  };
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
  return {
    signal,
    fetch: fetcher,
    resourceFetch,
    remainingBytes: () => remainingBytes,
    exhausted: () =>
      signal.aborted || requests >= PAGE_IMAGE_LIMITS.requests || remainingBytes <= 0,
  };
}

type Options = {
  fetch: typeof fetch;
  isAllowed: (url: URL, fetcher: typeof fetch, signal: AbortSignal) => Promise<boolean>;
  /** 記事ページと同じ HostGate に並ぶ。robots とリダイレクトもこの中で行う */
  run: <T>(url: string, task: () => Promise<T>) => Promise<T>;
  /** 先に使った上限の残り（Imgur の投稿のページを調べたとき）。なければ、ここで作る */
  budget?: PageFetchBudget | undefined;
};

export async function resolvePageImages(
  html: string,
  url: string,
  images: PageImageProcessor,
  options: Options,
): Promise<string> {
  const budget = options.budget ?? createPageFetchBudget(options.fetch);
  const { signal } = budget;
  const fetched = new Map<string, Resource | null>();
  async function resource(target: string): Promise<Resource | null> {
    if (fetched.has(target)) return fetched.get(target) ?? null;
    if (budget.remainingBytes() <= 0 || signal.aborted) return null;
    const result = await options.run(target, async () => {
      signal.throwIfAborted();
      const opts: FetchImageOptions = {
        fetch: budget.resourceFetch,
        signal,
        maxBytes: Math.min(budget.remainingBytes(), PAGE_IMAGE_LIMITS.resourceBytes),
        isAllowed: (target) => options.isAllowed(target, budget.fetch, signal),
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
      if (budget.exhausted()) break;
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
  // 導入の画像が、あとの画像と同じ写真なら、導入の画像を落とす（docs/decisions/content.md の 21）。
  // 上の拡大と同じ上限の残りの中で取り、上で取った画像は取り直さない。
  try {
    const { lead, later } = await images.leadImages(html, url);
    const exhausted = budget.exhausted;
    const picture = async (target: string) => {
      try {
        const result = await resource(target);
        return result?.kind === "image" ? result.bytes : null;
      } catch {
        // robots 不許可、404、予算切れなどは、照合しないだけにする。
        return null;
      }
    };
    for (const [index, src] of lead.entries()) {
      if (exhausted() && !fetched.has(src)) break;
      const bytes = await picture(src);
      if (!bytes) continue;
      for (const other of [...lead.slice(index + 1), ...later].slice(0, PAGE_IMAGE_LIMITS.links)) {
        if (exhausted() && !fetched.has(other)) break;
        const otherBytes = await picture(other);
        if (otherBytes && (await images.samePicture(bytes, otherBytes))) {
          html = await images.removeImage(html, src, url);
          break;
        }
      }
    }
  } catch {
    // 画像解析の失敗で、取得できた本文まで失わない。
  }
  return html;
}
