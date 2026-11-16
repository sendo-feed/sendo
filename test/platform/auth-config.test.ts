import { describe, expect, it, vi } from "vitest";
import { parseEmailList, parseOrigin } from "../../src/platform";
import { readAuthConfig } from "../../src/platform/config";

describe("ログインの設定", () => {
  it("許可するメールは、カンマか空白で区切り、小文字にそろえる", () => {
    expect([
      ...parseEmailList(" You@Example.com, other@example.com\nthird@example.com,, "),
    ]).toEqual(["you@example.com", "other@example.com", "third@example.com"]);
    expect(parseEmailList(undefined).size).toBe(0);
    expect(parseEmailList("").size).toBe(0);
  });

  it("Google のクライアントは、ID と秘密の両方があるときだけ使う", () => {
    expect(
      readAuthConfig({ GOOGLE_CLIENT_ID: " id ", GOOGLE_CLIENT_SECRET: "secret" }).google,
    ).toEqual({ clientId: "id", clientSecret: "secret" });
    expect(readAuthConfig({ GOOGLE_CLIENT_ID: "id" }).google).toBeUndefined();
    expect(
      readAuthConfig({ GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "" }).google,
    ).toBeUndefined();
    expect(readAuthConfig({}).allowedEmails.size).toBe(0);
  });

  it("OAuth の設定は、オリジン（https か、手元の http）だけを受け、末尾の / を除く", () => {
    expect(parseOrigin(" https://Sendo.example.com/ ")).toBe("https://sendo.example.com");
    expect(parseOrigin("http://localhost:8787")).toBe("http://localhost:8787");
    expect(parseOrigin("http://127.0.0.1:5173")).toBe("http://127.0.0.1:5173");
    expect(parseOrigin(undefined)).toBeUndefined();
    expect(parseOrigin("")).toBeUndefined();
    for (const value of [
      "http://sendo.example.com",
      "https://sendo.example.com/api",
      "https://sendo.example.com?x",
      "https://sendo.example.com#x",
      "https://user@sendo.example.com",
      "sendo.example.com",
    ]) {
      expect(() => parseOrigin(value), value).toThrow();
    }
  });

  it("OAuth は PUBLIC_URL と READER_URL の両方があるときだけ使う。形が正しくなければ使わない", () => {
    expect(
      readAuthConfig({
        PUBLIC_URL: "https://sendo.example.com",
        READER_URL: "https://reader.example.com/",
      }).oauth,
    ).toEqual({ issuer: "https://sendo.example.com", readerOrigin: "https://reader.example.com" });
    expect(readAuthConfig({ PUBLIC_URL: "https://sendo.example.com" }).oauth).toBeUndefined();
    // コンテナ版で sendo-reader と並べるときは、2 つとも reader のオリジンにする
    // （sendo-reader の docs/decisions/container.md の 2）
    expect(
      readAuthConfig({
        PUBLIC_URL: "https://reader.example.com",
        READER_URL: "https://reader.example.com",
      }).oauth,
    ).toEqual({ issuer: "https://reader.example.com", readerOrigin: "https://reader.example.com" });
    expect(readAuthConfig({ PUBLIC_URL: "", READER_URL: "" }).oauth).toBeUndefined();

    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(
      readAuthConfig({
        PUBLIC_URL: "http://sendo.example.com",
        READER_URL: "https://reader.example.com",
      }).oauth,
    ).toBeUndefined();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
