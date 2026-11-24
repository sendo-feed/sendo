/**
 * robots.txt（RFC 9309）。記事のページを取りにいく前に、取りにいってよいかを確かめる
 * （docs/decisions/content.md の 18）。フィードの取得には使わない。
 *
 * - parseRobotsTxt：Sendo に当てはまる規則だけを取り出す
 * - isAllowedByRules：規則で URL を照合する（最長一致。同じ長さなら Allow）
 * - fetchRobotsTxt：robots.txt を取りにいく。フィードの取得と同じ守りをかける
 * - RobotsCache：オリジンごとの結果を、プロセスのメモリに置く
 */
import { readPrefix } from "../lib/read-limited";
import { USER_AGENT } from "./fetch-feed";
import { toFetchableUrl, UrlNotAllowedError } from "./url-guard";

/** 照合に使う製品トークン（USER_AGENT の先頭） */
export const PRODUCT_TOKEN = "Sendo";

/** 規則 1 つ。pattern は、比べられるようにそろえたもの（normalizePath） */
export type RobotsRule = { allow: boolean; pattern: string };

/** robots.txt を取りにいった結果 */
export type RobotsTxt =
  /** 読めた。当てはまる規則（なければ空で、すべて許可） */
  | { status: "fetched"; rules: readonly RobotsRule[] }
  /** ない（429 を除く 4xx、リダイレクトが多すぎる）。すべて許可 */
  | { status: "unavailable" }
  /** 届かない（429、5xx、時間切れ、接続できない、SSRF の守りで止めた）。すべて不許可（一時的） */
  | ({ status: "unreachable" } & RobotsFailure);

type RobotsFailure =
  | { reason: "http_status"; httpStatus: number }
  | { reason: "redirect_without_location" | "blocked_url" | "timeout" | "network" };

export type RobotsDenial =
  | { code: "robots_disallowed"; reason: "rule" | "match_limit" | "aborted" }
  | ({ code: "robots_unreachable" } & RobotsFailure);

type Group = { agents: string[]; rules: RobotsRule[] };

/**
 * robots.txt を読み、製品トークンに当てはまる規則を返す。
 *
 * - 当たるグループ（User-agent の製品トークンが、大文字と小文字を区別せずに同じ）をすべてまとめる
 * - なければ、`*` のグループをすべてまとめる。それもなければ空（すべて許可）
 * - 続けて書いた User-agent の行は、1 つのグループになる。規則のあとの User-agent の行から、次のグループ
 * - 値が空の Allow ／ Disallow は、何にも当たらない（グループには数える）
 * - 知らない行（Sitemap、Crawl-delay など）は読まない
 */
export function parseRobotsTxt(text: string, productToken = PRODUCT_TOKEN): RobotsRule[] {
  const groups: Group[] = [];
  let current: Group | undefined;
  let inAgents = false;

  for (const rawLine of text.replace(/^\uFEFF/, "").split(/\r\n|\r|\n/)) {
    const line = rawLine.replace(/#.*$/, "");
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (key === "user-agent") {
      if (!current || !inAgents) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value);
      inAgents = true;
    } else if (key === "allow" || key === "disallow") {
      // どのグループにも入らない規則（User-agent の行より前）は読まない
      if (!current) continue;
      inAgents = false;
      if (value !== "")
        current.rules.push({ allow: key === "allow", pattern: normalizePath(value) });
    }
  }

  const token = productToken.toLowerCase();
  const matched = groups.filter((group) =>
    group.agents.some((agent) => agentToken(agent)?.toLowerCase() === token),
  );
  const chosen =
    matched.length > 0 ? matched : groups.filter((group) => group.agents.some((a) => a === "*"));
  return chosen.flatMap((group) => group.rules);
}

/**
 * User-agent の値から製品トークンを取り出す（`Sendo/1.0` なら `Sendo`）。製品トークンに使える文字
 * （英字、`_`、`-`）が先頭になければ null
 */
function agentToken(value: string): string | null {
  return value.match(/^[A-Za-z_-]+/)?.[0] ?? null;
}

/**
 * 1 つの URL の照合で、文字を比べてよい回数。robots.txt（500KiB まで）も URL も相手が決めるので、
 * 極端な組み合わせで、プロセスを長く止めないようにする（照合は同期の処理で、途中で止められない）。
 * ふつうの robots.txt（規則が数百、URL が数百文字）なら、この 1 割にも届かない
 */
export const MAX_MATCH_STEPS = 2_000_000;

class TooComplexError extends Error {}

/** 比べた回数を数え、上限を超えたら TooComplexError を投げる */
class Budget {
  #left = MAX_MATCH_STEPS;
  spend(steps: number): void {
    this.#left -= steps;
    if (this.#left < 0) throw new TooComplexError();
  }
}

/**
 * URL を規則で照合する。いちばん長く一致した規則を使い、Allow と Disallow が同じ長さなら Allow。
 * どれにも当たらなければ許可。`/robots.txt` そのものは、いつも許可。
 *
 * 照合の手間が上限（MAX_MATCH_STEPS）を超えたら、許可しない（届かないときと同じ、控えめなほう）
 */
export function isAllowedByRules(rules: readonly RobotsRule[], url: URL): boolean {
  return ruleDenial(rules, url) === null;
}

function ruleDenial(rules: readonly RobotsRule[], url: URL): "rule" | "match_limit" | null {
  if (url.pathname === "/robots.txt") return null;
  const target = normalizePath(`${url.pathname}${url.search}`);
  const budget = new Budget();
  let allow = -1;
  let disallow = -1;
  try {
    for (const rule of rules) {
      const length = rule.pattern.length;
      if (length <= (rule.allow ? allow : disallow)) continue;
      if (!matches(rule.pattern, target, budget)) continue;
      if (rule.allow) allow = length;
      else disallow = length;
    }
  } catch (error) {
    if (!(error instanceof TooComplexError)) throw error;
    console.warn("robots.txt is too complex to match; treating as disallowed", {
      origin: url.origin,
    });
    return "match_limit";
  }
  return allow >= disallow ? null : "rule";
}

/**
 * パターンの照合。`*` は任意の文字の並び、末尾の `$` は URL の終わり。`$` がなければ、先頭からの
 * 一致（後ろに何が続いてもよい）。
 *
 * `*` で区切った断片を、左から順に、いちばん手前で見つける（`*` だけのパターンでは、それで正しく
 * 決まる）。断片は KMP で探すので、1 つの規則の手間は、URL とパターンの長さの和に収まる
 * （後戻りする照合や正規表現、String.prototype.indexOf では、掛け算になることがある）
 */
function matches(pattern: string, target: string, budget: Budget): boolean {
  const anchored = pattern.endsWith("$");
  const parts = (anchored ? pattern.slice(0, -1) : pattern).split("*");
  const first = parts[0] ?? "";
  budget.spend(first.length + 1);
  if (!target.startsWith(first)) return false;
  if (parts.length === 1) return !anchored || target.length === first.length;

  const last = parts[parts.length - 1] ?? "";
  let position = first.length;
  for (const part of parts.slice(1, -1)) {
    if (part === "") continue;
    const found = find(part, target, position, budget);
    if (found === -1) return false;
    position = found + part.length;
  }
  // 最後の断片は、$ があれば URL の終わりに、なければどこかにあればよい
  if (anchored) {
    budget.spend(last.length + 1);
    return target.length - last.length >= position && target.endsWith(last);
  }
  return find(last, target, position, budget) !== -1;
}

/** target の from から後ろで、needle がはじめて現れる位置（KMP）。なければ -1 */
function find(needle: string, target: string, from: number, budget: Budget): number {
  const m = needle.length;
  if (m === 0) return from;
  if (target.length - from < m) return -1;
  budget.spend(2 * m);
  const failure = new Int32Array(m);
  for (let i = 1, k = 0; i < m; i++) {
    while (k > 0 && needle[i] !== needle[k]) k = failure[k - 1] ?? 0;
    if (needle[i] === needle[k]) k++;
    failure[i] = k;
  }
  // 探す側は、行き来を含めて target の残りの 2 倍までしか比べない
  budget.spend(2 * (target.length - from));
  for (let i = from, k = 0; i < target.length; i++) {
    while (k > 0 && target[i] !== needle[k]) k = failure[k - 1] ?? 0;
    if (target[i] === needle[k]) k++;
    if (k === m) return i - m + 1;
  }
  return -1;
}

/** RFC 3986 の、エンコードしなくてよい文字 */
const UNRESERVED = /^[A-Za-z0-9\-._~]$/;

/** RFC 3986 の、区切りに使う文字。`*` と `$` もここに入るので、パターンの記号はそのまま残る */
const RESERVED = /^[:/?#[\]@!$&'()*+,;=]$/;

/**
 * 比べられるようにそろえる（RFC 9309 の 2.2.2）。パターンにも URL にも同じものを当てる。
 *
 * - `%XX` のうち、エンコードしなくてよい文字（英数字と `-._~`）は戻す。ほかは 16 進を大文字にする
 * - ASCII でない文字と、そのままでは URL に書けない ASCII（空白、`"`、`<`、`{` など）は、UTF-8 で
 *   `%XX` にする（URL の側は、ブラウザと同じ決まりでエンコードされて届く）
 */
export function normalizePath(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const char = text.charAt(i);
    const hex = text.slice(i + 1, i + 3);
    if (char === "%" && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      const decoded = String.fromCharCode(Number.parseInt(hex, 16));
      out += UNRESERVED.test(decoded) ? decoded : `%${hex.toUpperCase()}`;
      i += 2;
    } else if (char === "%" || UNRESERVED.test(char) || RESERVED.test(char)) {
      out += char;
    } else {
      // サロゲートペアは 2 つで 1 文字なので、まとめてエンコードする
      const whole = String.fromCodePoint(text.codePointAt(i) ?? 0xfffd);
      out += encodeUtf8(whole);
      i += whole.length - 1;
    }
  }
  return out;
}

function encodeUtf8(char: string): string {
  try {
    return encodeURIComponent(char);
  } catch {
    // 対になっていないサロゲート
    return "%EF%BF%BD";
  }
}

const DEFAULTS = { timeoutMs: 10_000, maxBytes: 500 * 1024, maxRedirects: 5 };

/**
 * オリジンの robots.txt を取りにいく。例外は投げない（届かなければ unreachable）。
 *
 * - フィードと同じ守り：toFetchableUrl、リダイレクトごとの確認、時間の上限。接続する IP の確認は、
 *   緩衝層の fetch（platform/node/safe-fetch.ts）が行う
 * - 最初の maxBytes だけを読み、そこで切れた最後の行は捨てる
 * - 2xx は読む。429 を除く 4xx はない（すべて許可）。429、5xx と届かないときは unreachable（すべて不許可）。
 *   429 は、回数を減らしてほしいというサイトの知らせなので、Google と同じく 5xx と同じに扱う
 * - リダイレクトは maxRedirects 回までたどる。それを超えたら、ない（すべて許可）
 */
export async function fetchRobotsTxt(
  origin: string,
  options: { fetch: typeof fetch; timeoutMs?: number; maxBytes?: number; maxRedirects?: number },
): Promise<RobotsTxt> {
  const { timeoutMs, maxBytes, maxRedirects } = { ...DEFAULTS, ...options };
  const signal = AbortSignal.timeout(timeoutMs);
  const headers = { accept: "text/plain,*/*;q=0.1", "user-agent": USER_AGENT };

  try {
    let current = toFetchableUrl(new URL("/robots.txt", origin));
    for (let redirects = 0; ; redirects++) {
      const res = await options.fetch(current, { headers, redirect: "manual", signal });

      if ([301, 302, 303, 307, 308].includes(res.status)) {
        await res.body?.cancel();
        const location = res.headers.get("location");
        if (!location) return { status: "unreachable", reason: "redirect_without_location" };
        if (redirects >= maxRedirects) return { status: "unavailable" };
        current = toFetchableUrl(new URL(location, current));
        continue;
      }
      if (res.status >= 200 && res.status < 300) {
        const { bytes, truncated } = await readPrefix(res.body, maxBytes);
        let text = new TextDecoder().decode(bytes);
        // 途中で切れた行は、意味が変わっているかもしれないので捨てる
        if (truncated)
          text = text.slice(0, Math.max(text.lastIndexOf("\n"), text.lastIndexOf("\r"), 0));
        return { status: "fetched", rules: parseRobotsTxt(text) };
      }
      await res.body?.cancel();
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        return { status: "unavailable" };
      }
      return { status: "unreachable", reason: "http_status", httpStatus: res.status };
    }
  } catch (error) {
    const cause = error instanceof TypeError ? error.cause : error;
    const code = cause instanceof Error && "code" in cause ? cause.code : undefined;
    if (signal.aborted || code === "UND_ERR_CONNECT_TIMEOUT" || code === "ETIMEDOUT") {
      return { status: "unreachable", reason: "timeout" };
    }
    if (error instanceof UrlNotAllowedError || code === "ERR_PRIVATE_ADDRESS") {
      return { status: "unreachable", reason: "blocked_url" };
    }
    return { status: "unreachable", reason: "network" };
  }
}

/** 読めた結果と、ないという結果を置く時間（RFC 9309 の 2.4。24 時間まで） */
export const ROBOTS_TTL_MS = 24 * 60 * 60 * 1000;

/** 届かなかった結果を置く時間。同じサイトの記事が続くときに、取りにいき直さないための短い間 */
export const ROBOTS_UNREACHABLE_TTL_MS = 10 * 60 * 1000;

/** 置くオリジンの数。超えたら、古く置いたものから捨てる */
export const ROBOTS_MAX_ENTRIES = 1000;

type CacheEntry = { result: RobotsTxt; expiresAt: number };

/**
 * robots.txt の結果を、オリジン（スキーム、ホスト、ポート）ごとに、プロセスのメモリに置く。
 * Sendo は 1 つのプロセスで動く（docs/decisions/container.md の 7）ので、DB には置かない
 */
type RobotsContext = { fetch: typeof fetch; now: Date; signal?: AbortSignal };

export class RobotsCache {
  readonly #entries = new Map<string, CacheEntry>();
  readonly #inflight = new Map<string, Promise<RobotsTxt>>();
  readonly #maxEntries: number;

  constructor(options: { maxEntries?: number } = {}) {
    this.#maxEntries = options.maxEntries ?? ROBOTS_MAX_ENTRIES;
  }

  /** URL を取りにいってよいか。オリジンの結果がなければ（古ければ）取りにいく */
  async isAllowed(url: URL, context: RobotsContext): Promise<boolean> {
    return (await this.denial(url, context)) === null;
  }

  /** 拒否または確認できなかった理由。取得してよければ null */
  async denial(url: URL, context: RobotsContext): Promise<RobotsDenial | null> {
    if (context.signal?.aborted) return { code: "robots_disallowed", reason: "aborted" };
    if (url.pathname === "/robots.txt") return null;
    const result = await this.#get(url.origin, context);
    if (context.signal?.aborted) return { code: "robots_disallowed", reason: "aborted" };
    switch (result.status) {
      case "fetched": {
        const reason = ruleDenial(result.rules, url);
        return reason === null ? null : { code: "robots_disallowed", reason };
      }
      case "unavailable":
        return null;
      case "unreachable": {
        const { status: _, ...failure } = result;
        return { code: "robots_unreachable", ...failure };
      }
    }
  }

  async #get(origin: string, context: RobotsContext): Promise<RobotsTxt> {
    const cached = this.#entries.get(origin);
    if (cached && cached.expiresAt > context.now.getTime()) return cached.result;

    // 同じオリジンを、同時に何度も取りにいかない
    const running = this.#inflight.get(origin);
    if (running) return running;
    const task = fetchRobotsTxt(origin, { fetch: context.fetch })
      .then((result) => {
        // 取得元の障害と、呼び出し側だけの期限・予算切れを区別する。
        // 中断された画像探索の結果は、別の記事へ持ち越さない。
        if (context.signal?.aborted) return result;
        if (result.status === "unreachable") {
          const { status: _, ...failure } = result;
          console.warn("could not fetch robots.txt; treating as disallowed", {
            origin,
            ...failure,
          });
        }
        this.#put(origin, result, context.now);
        return result;
      })
      .finally(() => {
        if (!context.signal) this.#inflight.delete(origin);
      });
    // 呼び出し側の中断に依存する仕事を、通常の本文取得へ共有しない。
    if (!context.signal) this.#inflight.set(origin, task);
    return task;
  }

  #put(origin: string, result: RobotsTxt, now: Date): void {
    const ttl = result.status === "unreachable" ? ROBOTS_UNREACHABLE_TTL_MS : ROBOTS_TTL_MS;
    // 置き直したものを後ろへ回す（Map は入れた順に並ぶ）
    this.#entries.delete(origin);
    this.#entries.set(origin, { result, expiresAt: now.getTime() + ttl });
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }
}
