import { describe, expect, it, vi } from "vitest";
import { parseFetchIntervalMinutes, parseStorageLimitMiB } from "../../src/platform";
import { readFetchConfig, readRetentionConfig } from "../../src/platform/config";

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

describe("保存容量の設定", () => {
  it("MiB の整数を受け、未指定は既定（10 GiB）を使う", () => {
    expect(parseStorageLimitMiB(" 20480 ")).toBe(20480);
    expect(parseStorageLimitMiB(undefined)).toBeUndefined();
    expect(readRetentionConfig({})).toEqual({ maxBytes: 10 * 1024 ** 3 });
    expect(readRetentionConfig({ STORAGE_LIMIT_MIB: "20480" })).toEqual({
      maxBytes: 20 * 1024 ** 3,
    });
  });
  it("誤設定では小さい既定値へ戻さず、削除を始める前に例外にする", () => {
    for (const value of ["0", "15", "-1", "16.5", "Infinity", "1e3", "9007199254740992"]) {
      expect(() => readRetentionConfig({ STORAGE_LIMIT_MIB: value }), value).toThrow(RangeError);
    }
  });
});
