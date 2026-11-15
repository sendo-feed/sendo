import { describe, expect, it, vi } from "vitest";
import { parseFetchIntervalMinutes } from "../../src/platform";
import { readFetchConfig } from "../../src/platform/cloudflare";

const MINUTE = 60 * 1000;

describe("取得の設定", () => {
  it("取得の間隔は、10 以上の整数（分）だけを受ける。空なら既定に任せる", () => {
    expect(parseFetchIntervalMinutes(" 60 ")).toBe(60);
    expect(parseFetchIntervalMinutes("10")).toBe(10);
    expect(parseFetchIntervalMinutes(undefined)).toBeUndefined();
    expect(parseFetchIntervalMinutes("")).toBeUndefined();
    for (const value of ["9", "0", "-30", "30.5", "1e3", "thirty"]) {
      expect(() => parseFetchIntervalMinutes(value), value).toThrow(RangeError);
    }
  });

  it("env の FETCH_INTERVAL_MINUTES を読む。なければ 30 分", () => {
    expect(readFetchConfig({ FETCH_INTERVAL_MINUTES: "60" })).toEqual({ intervalMs: 60 * MINUTE });
    expect(readFetchConfig({})).toEqual({ intervalMs: 30 * MINUTE });
  });

  it("形が正しくなければ、エラーをログに出して 30 分にする", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(readFetchConfig({ FETCH_INTERVAL_MINUTES: "5" })).toEqual({ intervalMs: 30 * MINUTE });
    expect(errors).toHaveBeenCalledOnce();
    errors.mockRestore();
  });
});
