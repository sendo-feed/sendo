import path from "node:path";
import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { testDatabase } from "../../db";

/**
 * 本番と同じ openDatabase で開いた DB（test/db.ts）の接続（sendo-feed/sendo#215）。
 * 重なった呼び出しのどれにも待ち時間と外部キーが効き、ほかの接続が書き込みのロックを持っている間に
 * 書き込みを重ねても、SQLITE_BUSY で落ちずに待つ
 */
describe("重なった呼び出しの接続（sendo-feed/sendo#215）", () => {
  it("どの呼び出しでも、busy_timeout と外部キーが効いている", async () => {
    const { client } = testDatabase;
    const timeouts = await Promise.all(
      Array.from({ length: 10 }, () => client.execute("PRAGMA busy_timeout")),
    );
    const foreignKeys = await Promise.all(
      Array.from({ length: 10 }, () => client.execute("PRAGMA foreign_keys")),
    );
    expect(timeouts.map((r) => Number(r.rows[0]?.[0]))).toEqual(Array(10).fill(5000));
    expect(foreignKeys.map((r) => Number(r.rows[0]?.[0]))).toEqual(Array(10).fill(1));
  });

  it("ほかの接続が書き込みのロックを持つ間に書き込みを重ねても、待って通る", async () => {
    // 同じスレッドで待つと、待っている間にロックが外れないので、別のスレッドでロックを持つ
    const worker = new Worker(
      `
      const { parentPort, workerData } = require("node:worker_threads");
      const { createClient } = require("@libsql/client");
      (async () => {
        const client = createClient({ url: workerData.url });
        const tx = await client.transaction("write");
        await tx.execute("UPDATE storage_usage SET bytes = bytes WHERE id = 1");
        parentPort.postMessage("locked");
        await new Promise((resolve) => setTimeout(resolve, 300));
        await tx.commit();
        client.close();
        parentPort.postMessage("released");
      })().catch((error) => parentPort.postMessage(String(error)));
      `,
      {
        eval: true,
        workerData: { url: `file:${path.join(testDatabase.directory, "sendo.db")}` },
      },
    );
    const messages: string[] = [];
    const released = new Promise<void>((resolve) => {
      worker.on("message", (message: string) => {
        messages.push(message);
        if (message !== "locked") resolve();
      });
    });
    await new Promise<void>((resolve) => worker.once("message", () => resolve()));
    expect(messages).toEqual(["locked"]);

    // 先頭は読み取り（WAL ではロックを待たない）。書き込みは、そのあとに重ねる。接続が何本もあると、
    // 書き込みは先頭とは別の接続に回る
    const results = await Promise.allSettled([
      testDatabase.client.execute("SELECT bytes FROM storage_usage WHERE id = 1"),
      ...Array.from({ length: 4 }, () =>
        testDatabase.client.execute("UPDATE storage_usage SET bytes = bytes WHERE id = 1"),
      ),
    ]);
    await released;
    await worker.terminate();
    expect(messages).toEqual(["locked", "released"]);
    expect(results.filter((r) => r.status === "rejected").map((r) => String(r.reason))).toEqual([]);
  });
});
