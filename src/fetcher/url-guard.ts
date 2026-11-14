/**
 * 外部の URL を取得してよいかを確かめる（SSRF 対策）。
 *
 * ホスト名が内部向けのものや、IP アドレスが内部・予約済みの範囲のものを拒む。
 * リダイレクトの行き先にも、取得のたびに同じ確認をかける（fetch-feed.ts）。
 *
 * ここではホスト名の文字列しか見ない。名前解決の結果（DNS リバインディング）までは
 * 確かめられないので、Cloudflare 以外に移植するときは、接続する IP アドレスを
 * 確かめる仕組みを platform 側に足す必要がある。Cloudflare の Workers からは、
 * 内部のネットワークにはそもそも届かない。
 */

export class UrlNotAllowedError extends Error {
  override readonly name = "UrlNotAllowedError";
  constructor(
    readonly reason:
      | "invalid_url"
      | "unsupported_scheme"
      | "credentials_in_url"
      | "unsupported_port"
      | "private_host",
  ) {
    super(`URL is not allowed: ${reason}`);
  }
}

/** 標準のポートと、よく使われる代わりのポートだけを許す */
const ALLOWED_PORTS = new Set(["", "80", "443", "8080", "8443"]);

/** 内部向けに使われるホスト名の末尾 */
const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".intranet", ".lan", ".home.arpa"];

/**
 * 取得してよい URL なら、正規化した URL を返す。だめなら UrlNotAllowedError を投げる。
 */
export function toFetchableUrl(input: string | URL): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new UrlNotAllowedError("invalid_url");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UrlNotAllowedError("unsupported_scheme");
  }
  if (url.username !== "" || url.password !== "") {
    throw new UrlNotAllowedError("credentials_in_url");
  }
  if (!ALLOWED_PORTS.has(url.port)) {
    throw new UrlNotAllowedError("unsupported_port");
  }
  if (isPrivateHost(url.hostname)) {
    throw new UrlNotAllowedError("private_host");
  }

  url.hash = "";
  return url;
}

/**
 * 内部向けのホストかどうか。
 * URL のパーサーは、10 進や 16 進で書かれた IPv4 も「127.0.0.1」の形に直してくれるので、
 * ここでは正規化された表記だけを相手にすればよい。
 */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");

  if (host.startsWith("[") && host.endsWith("]")) {
    const ipv6 = parseIpv6(host.slice(1, -1));
    return ipv6 === null || isPrivateIpv6(ipv6);
  }

  const ipv4 = parseIpv4(host);
  if (ipv4 !== null) return isPrivateIpv4(ipv4);

  if (host === "localhost") return true;
  if (BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  // 点のないホスト名（例：intranet）は、公開のインターネットの名前ではない
  if (!host.includes(".")) return true;
  return false;
}

/** 拒む IPv4 の範囲（[先頭のアドレス, プレフィックス長]） */
const PRIVATE_IPV4: ReadonlyArray<readonly [number, number]> = [
  [ipv4(0, 0, 0, 0), 8], // 「このネットワーク」
  [ipv4(10, 0, 0, 0), 8], // プライベート
  [ipv4(100, 64, 0, 0), 10], // キャリアグレード NAT
  [ipv4(127, 0, 0, 0), 8], // ループバック
  [ipv4(169, 254, 0, 0), 16], // リンクローカル（クラウドのメタデータを含む）
  [ipv4(172, 16, 0, 0), 12], // プライベート
  [ipv4(192, 0, 0, 0), 24], // IETF のプロトコル割り当て
  [ipv4(192, 0, 2, 0), 24], // 文書用
  [ipv4(192, 88, 99, 0), 24], // 6to4 リレー
  [ipv4(192, 168, 0, 0), 16], // プライベート
  [ipv4(198, 18, 0, 0), 15], // ベンチマーク用
  [ipv4(198, 51, 100, 0), 24], // 文書用
  [ipv4(203, 0, 113, 0), 24], // 文書用
  [ipv4(224, 0, 0, 0), 4], // マルチキャスト
  [ipv4(240, 0, 0, 0), 4], // 予約済み（ブロードキャストを含む）
];

function ipv4(a: number, b: number, c: number, d: number): number {
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

function parseIpv4(host: string): number | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = value * 256 + n;
  }
  return value;
}

function isPrivateIpv4(address: number): boolean {
  return PRIVATE_IPV4.some(([base, prefix]) => {
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return (address & mask) >>> 0 === base;
  });
}

/** IPv6 を 16 ビットずつ 8 つの数に分ける。URL のパーサーが正規化した表記を前提にする */
function parseIpv6(text: string): number[] | null {
  const halves = text.split("::");
  if (halves.length > 2) return null;

  const toGroups = (part: string): number[] | null => {
    if (part === "") return [];
    const groups: number[] = [];
    for (const group of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      groups.push(Number.parseInt(group, 16));
    }
    return groups;
  };

  const head = toGroups(halves[0] ?? "");
  const tail = halves.length === 2 ? toGroups(halves[1] ?? "") : [];
  if (head === null || tail === null) return null;

  if (halves.length === 1) return head.length === 8 ? head : null;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return null;
  return [...head, ...Array<number>(missing).fill(0), ...tail];
}

function isPrivateIpv6(groups: readonly number[]): boolean {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;
  const embeddedIpv4 = ((g6 << 16) | g7) >>> 0;

  // ::（未指定）と ::1（ループバック）、::/96（IPv4 互換、廃止済み）
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return true;
  // ::ffff:0:0/96（IPv4 射影）は、埋め込まれた IPv4 で判断する
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return isPrivateIpv4(embeddedIpv4);
  }
  // 64:ff9b::/96（NAT64）も、埋め込まれた IPv4 で判断する
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return isPrivateIpv4(embeddedIpv4);
  }
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 ユニークローカル
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 リンクローカル
  if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8 マルチキャスト
  if (g0 === 0x2001 && g1 === 0x0db8) return true; // 2001:db8::/32 文書用
  if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) return true; // 100::/64 破棄用
  return false;
}
