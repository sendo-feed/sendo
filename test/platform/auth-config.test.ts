import { describe, expect, it } from "vitest";
import { parseEmailList } from "../../src/platform";
import { readAuthConfig } from "../../src/platform/cloudflare";

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
});
