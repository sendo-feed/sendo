import { FetchFeedError, parseRetryAfter } from "../../fetcher/fetch-feed";
import { readLimited } from "../../lib/read-limited";

const API = "https://discord.com";
const VERSION = "/api/v10/";
const MAX_RATE_LIMIT_BODY = 4096;
const REQUEST_TIMEOUT_MS = 10_000;

function secondsAsMilliseconds(value: string | number | null): number | undefined {
  if (value === null || (typeof value === "string" && !/^\d+(?:\.\d+)?$/.test(value))) {
    return undefined;
  }
  const seconds = Number(value);
  const milliseconds = Math.ceil(seconds * 1000);
  return seconds >= 0 && Number.isFinite(milliseconds) ? milliseconds : undefined;
}

function validWait(at: number, wait: number | undefined): number | undefined {
  return wait !== undefined && Number.isFinite(new Date(at + wait).getTime()) ? wait : undefined;
}

function resetDelay(headers: Headers, at: number) {
  const relative = validWait(at, secondsAsMilliseconds(headers.get("x-ratelimit-reset-after")));
  if (relative !== undefined) return relative;
  const absolute = secondsAsMilliseconds(headers.get("x-ratelimit-reset"));
  if (absolute === undefined) return undefined;
  const sentAt = Date.parse(headers.get("date") ?? "");
  const wait = absolute - (Number.isFinite(sentAt) ? sentAt : at);
  return wait > 0 ? validWait(at, wait) : undefined;
}

function describeRoute(path: string) {
  const parts = path.slice(VERSION.length).split("/");
  const [name, id] = parts;
  const resource = (name === "guilds" || name === "channels") && id ? `${name}:${id}` : "";
  const route = parts.map((part) => (/^\d+$/.test(part) ? ":id" : part)).join("/");
  return { route, resource };
}

async function readLimit(response: Response, observedAt: number) {
  const headers = response.headers;
  let global =
    headers.get("x-ratelimit-global") === "true" || headers.get("x-ratelimit-scope") === "global";
  const retry = headers.get("retry-after")?.trim() ?? null;
  let wait = validWait(
    observedAt,
    secondsAsMilliseconds(retry) ??
      parseRetryAfter(retry, { date: headers.get("date"), now: new Date(observedAt) }),
  );
  if (wait === undefined) {
    // Discord REST は、ヘッダーに加えて JSON の retry_after と global も返す。
    try {
      const data = await readLimited(
        response.body,
        headers.get("content-length"),
        MAX_RATE_LIMIT_BODY,
      );
      const payload: { retry_after?: unknown; global?: unknown } | null = JSON.parse(
        new TextDecoder().decode(data),
      );
      if (typeof payload?.retry_after === "number")
        wait = validWait(observedAt, secondsAsMilliseconds(payload.retry_after));
      global ||= payload?.global === true;
    } catch {
      // 読めない場合も、レスポンス本文をログに残さない。
    }
  }
  if (!global) wait ??= resetDelay(headers, observedAt);
  return { global, wait };
}

function rateLimited(message: string, wait?: number): FetchFeedError {
  return new FetchFeedError("rate_limited", message, 429, wait);
}

/** Bot の読み取りを順に出し、直前の応答で分かった Discord の制限を次の送信に反映する。 */
export function createDiscordBotFetch(
  fetch: typeof globalThis.fetch,
  botToken: string,
  now: () => number = Date.now,
): typeof globalThis.fetch {
  const authorization = `Bot ${botToken}`;
  const bucketByRoute = new Map<string, string>();
  const deadlines = new Map<string, number>();
  let globalUntil = 0;
  let tail = Promise.resolve();

  async function send(input: URL, init: RequestInit | undefined): Promise<Response> {
    init?.signal?.throwIfAborted();
    const { route, resource } = describeRoute(input.pathname);
    const routeKey = JSON.stringify([route, resource]);
    const bucket = bucketByRoute.get(route);
    const bucketKey = bucket ? JSON.stringify(["bucket", bucket, resource]) : undefined;
    const at = now();
    for (const [key, until] of deadlines) {
      if (until <= at) deadlines.delete(key);
    }
    const until = Math.max(
      globalUntil,
      deadlines.get(routeKey) ?? 0,
      bucketKey ? (deadlines.get(bucketKey) ?? 0) : 0,
    );
    if (until > at) throw rateLimited("Discord REST rate limit has not reset", until - at);

    // 順番待ちを通信の期限に含めない。中断済みの仕事は送らない。
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    const response = await fetch(input, { ...init, signal });
    const receivedAt = now();
    const receivedBucket = response.headers.get("x-ratelimit-bucket");
    if (receivedBucket) bucketByRoute.set(route, receivedBucket);
    const limitKey = receivedBucket
      ? JSON.stringify(["bucket", receivedBucket, resource])
      : (bucketKey ?? routeKey);
    if (response.status === 429) {
      const { global, wait } = await readLimit(response, receivedAt);
      if (!response.bodyUsed) void response.body?.cancel().catch(() => undefined);
      if (wait === undefined) throw rateLimited("Discord returned HTTP 429");
      const deadline = receivedAt + wait;
      if (global) globalUntil = Math.max(globalUntil, deadline);
      else deadlines.set(limitKey, Math.max(deadlines.get(limitKey) ?? 0, deadline));
      throw rateLimited("Discord returned HTTP 429", Math.max(0, deadline - now()));
    }
    if (response.headers.get("x-ratelimit-remaining") === "0") {
      const wait = resetDelay(response.headers, receivedAt);
      if (wait !== undefined) {
        deadlines.set(limitKey, Math.max(deadlines.get(limitKey) ?? 0, receivedAt + wait));
      }
    }
    return response;
  }

  return (input, init) => {
    if (
      (typeof input !== "string" && !(input instanceof URL)) ||
      (init?.method ?? "GET").toUpperCase() !== "GET" ||
      new Headers(init?.headers).get("authorization") !== authorization
    ) {
      return fetch(input, init);
    }
    const url = new URL(input);
    if (url.origin !== API || !url.pathname.startsWith(VERSION)) return fetch(input, init);
    const task = tail.then(() => send(url, init));
    tail = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  };
}
