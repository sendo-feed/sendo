import type { LookupAddress } from "node:dns";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createGuardedLookup,
  createSafeFetch,
  PrivateAddressError,
  type Resolver,
} from "../../src/platform/node/safe-fetch";

/** 名前ごとに決まったアドレスを返す。外への通信はしない */
function fakeResolver(table: Record<string, LookupAddress[]>): Resolver {
  return async (hostname) => {
    const addresses = table[hostname];
    if (addresses === undefined) {
      throw Object.assign(new Error(`not found: ${hostname}`), { code: "ENOTFOUND" });
    }
    return addresses;
  };
}

type LookupResult = { error: Error | null; address: unknown; family?: number | undefined };

function lookup(resolver: Resolver, hostname: string, options: { all?: boolean; family?: number }) {
  return new Promise<LookupResult>((resolve) => {
    createGuardedLookup(resolver)(hostname, options, (error, address, family) =>
      resolve({ error, address, family }),
    );
  });
}

const PUBLIC_V4 = { address: "93.184.216.34", family: 4 };
const PUBLIC_V6 = { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 };

describe("接続する IP アドレスの確認", () => {
  const resolver = fakeResolver({
    "public.example": [PUBLIC_V4, PUBLIC_V6],
    "rebind.example": [PUBLIC_V4, { address: "127.0.0.1", family: 4 }],
    "metadata.example": [{ address: "169.254.169.254", family: 4 }],
    "mapped.example": [{ address: "::ffff:10.0.0.1", family: 6 }],
  });

  it("公開のアドレスに解決される名前は通す", async () => {
    expect(await lookup(resolver, "public.example", { all: true })).toEqual({
      error: null,
      address: [PUBLIC_V4, PUBLIC_V6],
      family: undefined,
    });
    expect(await lookup(resolver, "public.example", {})).toEqual({
      error: null,
      address: PUBLIC_V4.address,
      family: 4,
    });
    expect(await lookup(resolver, "public.example", { family: 6 })).toEqual({
      error: null,
      address: PUBLIC_V6.address,
      family: 6,
    });
  });

  it.each(["rebind.example", "metadata.example", "mapped.example"])(
    "内部のアドレスに解決される名前は、1 つでも含めば拒む: %s",
    async (hostname) => {
      const result = await lookup(resolver, hostname, { all: true });
      expect(result.error).toBeInstanceOf(PrivateAddressError);
    },
  );

  it("解決できない名前は、名前解決のエラーをそのまま返す", async () => {
    const result = await lookup(resolver, "missing.example", {});
    expect(result.error).toMatchObject({ code: "ENOTFOUND" });
  });
});

describe("createSafeFetch", () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    server = createServer((_, res) => res.end("secret"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it("内部のアドレスで書かれた宛先にはつながない", async () => {
    const safeFetch = createSafeFetch(fakeResolver({}));
    const error = await safeFetch(`http://127.0.0.1:${port}/`).catch((e: unknown) => e);
    expect((error as Error).cause).toBeInstanceOf(PrivateAddressError);
  });

  it("内部のアドレスに解決される名前（DNS リバインディング）にもつながない", async () => {
    const safeFetch = createSafeFetch(
      fakeResolver({ "rebind.example": [{ address: "127.0.0.1", family: 4 }] }),
    );
    const error = await safeFetch(`http://rebind.example:${port}/`).catch((e: unknown) => e);
    expect((error as Error).cause).toBeInstanceOf(PrivateAddressError);
  });

  it("Request は受けない（URL か文字列だけ）", () => {
    const safeFetch = createSafeFetch(fakeResolver({}));
    expect(() => safeFetch(new Request("https://public.example/"))).toThrow(TypeError);
  });
});
