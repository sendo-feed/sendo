/**
 * 外への取得で、接続する IP アドレスも確かめる fetch（docs/decisions/container.md の 8）。
 *
 * fetcher/ の toFetchableUrl は、ホスト名の文字列しか見ない。Workers からは内部のネットワークに
 * 届かないのでそれで足りるが、コンテナからは届く。内部のアドレスに解決されるドメインや、
 * DNS リバインディングで突破されないように、名前解決の結果を、接続する直前に確かめる。
 *
 * 確かめるのは、接続のたびに呼ばれる lookup の中。リダイレクトの行き先や、つなぎ直しも同じ道を通る。
 * 解決した名前を確かめたあとで、もう一度別の名前解決をすることはない（確かめたアドレスにつなぐ）。
 */
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { isIP, type LookupFunction } from "node:net";
import { Agent, buildConnector, fetch as undiciFetch } from "undici";
import { isPrivateIpAddress } from "../../fetcher/url-guard";

/** 内部・予約済みのアドレスにつなごうとした */
export class PrivateAddressError extends Error {
  override readonly name = "PrivateAddressError";
  readonly code = "ERR_PRIVATE_ADDRESS";
  constructor(readonly hostname: string) {
    super(`refusing to connect to a private address: ${hostname}`);
  }
}

/** 名前を解決して、すべてのアドレスを返す */
export type Resolver = (hostname: string) => Promise<LookupAddress[]>;

const systemResolver: Resolver = (hostname) =>
  new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error) reject(error);
      else resolve(addresses);
    });
  });

/**
 * 解決したアドレスに、内部・予約済みのものが 1 つでもあれば拒む lookup。
 * 一部だけを拒んで残りにつなぐと、どれにつながるかを相手に選ばせることになるので、まとめて拒む
 */
export function createGuardedLookup(resolve: Resolver = systemResolver): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname).then(
      (all) => {
        if (all.length === 0) {
          callback(
            Object.assign(new Error(`no address for ${hostname}`), { code: "ENOTFOUND" }),
            "",
          );
          return;
        }
        if (all.some(({ address }) => isPrivateIpAddress(address))) {
          callback(new PrivateAddressError(hostname), "");
          return;
        }
        const family = options.family === 4 || options.family === 6 ? options.family : 0;
        const addresses = family === 0 ? all : all.filter((entry) => entry.family === family);
        const first = addresses[0];
        if (first === undefined) {
          callback(
            Object.assign(new Error(`no address for ${hostname}`), { code: "ENOTFOUND" }),
            "",
          );
          return;
        }
        if (options.all) callback(null, addresses);
        else callback(null, first.address, first.family);
      },
      (error: NodeJS.ErrnoException) => callback(error, ""),
    );
  };
}

/** つなぐ前に、IP アドレスで書かれた宛先も確かめる（名前解決を通らないため） */
function guardedConnector(lookup: LookupFunction): buildConnector.connector {
  const connect = buildConnector({ lookup, timeout: 10_000 });
  return (options, callback) => {
    const host = options.hostname.replace(/^\[(.*)\]$/, "$1");
    if (isIP(host) !== 0 && isPrivateIpAddress(host)) {
      callback(new PrivateAddressError(host), null);
      return;
    }
    connect(options, callback);
  };
}

/** 応答の頭や本文が届くのを待つ上限。fetcher/ の側でも、それぞれの上限で打ち切る */
const RESPONSE_TIMEOUT_MS = 60_000;

/**
 * 接続する IP アドレスを確かめる fetch を作る。呼ぶ側（fetcher/）は、URL か文字列を渡す
 * （Request は受けない。中身を写すときに、確かめる前の情報が混ざらないように）
 */
export function createSafeFetch(resolve?: Resolver): typeof fetch {
  const dispatcher = new Agent({
    connect: guardedConnector(createGuardedLookup(resolve)),
    headersTimeout: RESPONSE_TIMEOUT_MS,
    bodyTimeout: RESPONSE_TIMEOUT_MS,
  });
  const safeFetch = (input: string | URL | Request, init?: RequestInit) => {
    if (typeof input !== "string" && !(input instanceof URL)) {
      throw new TypeError("safe fetch takes a URL or a string");
    }
    // undici の fetch と、Node に組み込みの fetch とは、型の上では別のものなので、ここで合わせる
    return undiciFetch(input, {
      ...(init as Parameters<typeof undiciFetch>[1]),
      dispatcher,
    }) as unknown as Promise<Response>;
  };
  return safeFetch as typeof fetch;
}
