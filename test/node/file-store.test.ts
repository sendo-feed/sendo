import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ObjectStore } from "../../src/platform";
import { createFileObjectStore } from "../../src/platform/node/file-store";

describe("ファイルの置き場", () => {
  let root: string;
  let store: ObjectStore;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "sendo-content-"));
    store = createFileObjectStore(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("置いて、読んで、消す。同じ名前は上書きする", async () => {
    await store.put("feed/0123abcd", "<p>一つ目</p>");
    await store.put("feed/0123abcd", "<p>二つ目</p>");
    expect(await store.get("feed/0123abcd")).toBe("<p>二つ目</p>");
    // 書きかけの一時ファイルは残らない
    expect(await readdir(path.join(root, "feed"))).toEqual(["0123abcd"]);

    await store.delete(["feed/0123abcd", "feed/missing"]);
    expect(await store.get("feed/0123abcd")).toBeNull();
  });

  it("ない名前は null を返す", async () => {
    expect(await store.get("feed/missing")).toBeNull();
  });

  it.each(["../outside", "feed/../../outside", "/etc/passwd", "feed//x", "feed/x.tmp", ""])(
    "置き場の外を指しうる名前は受けない: %s",
    async (key) => {
      await expect(store.put(key, "x")).rejects.toThrow(RangeError);
      await expect(store.get(key)).rejects.toThrow(RangeError);
      await expect(store.delete([key])).rejects.toThrow(RangeError);
    },
  );
});
