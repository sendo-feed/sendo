/**
 * 記事の本文の置き場を、ボリュームの上のファイルにする（docs/decisions/container.md の 7）。
 * Cloudflare 版の R2 と同じく、置く、読む、消すだけを使う。
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ObjectStore } from "..";

/**
 * 置き場の名前として受ける形。名前は sendo が作る（例：feed/0123abcd…）ので、英数字と _ と - を
 * / で区切ったものだけを受ける。.. などで、置き場の外を指せないようにする
 */
const KEY_PATTERN = /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/;

function assertKey(key: string): void {
  if (!KEY_PATTERN.test(key) || key.length > 512) {
    throw new RangeError(`invalid object key: ${key}`);
  }
}

export function createFileObjectStore(root: string): ObjectStore {
  const fileOf = (key: string) => {
    assertKey(key);
    return path.join(root, key);
  };
  return {
    async put(key, text) {
      const file = fileOf(key);
      await mkdir(path.dirname(file), { recursive: true });
      // 書きかけのファイルを読ませないように、別の名前で書いてから置き換える
      const temporary = `${file}.${crypto.randomUUID()}.tmp`;
      await writeFile(temporary, text, "utf8");
      await rename(temporary, file);
    },
    async get(key) {
      try {
        return await readFile(fileOf(key), "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    async delete(keys) {
      // ない名前は、そのまま通す（force）
      await Promise.all(keys.map((key) => rm(fileOf(key), { force: true })));
    },
  };
}
