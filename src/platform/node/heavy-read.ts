/**
 * 重い読み取り（docs/decisions/container.md の 5）。主のスレッドとは別のスレッド（worker）を 1 本持ち、
 * そのスレッドが開いた接続で文を流す。libsql は文を同期で動かすので、主のスレッドで流すと、その間は
 * イベントループが止まる。
 */
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import type { SQL } from "drizzle-orm";
import { SQLiteAsyncDialect } from "drizzle-orm/sqlite-core";
import type { HeavyRead } from "..";

export interface WorkerHeavyRead extends HeavyRead {
  /** 別のスレッドを止める。流している文と待っている文は失敗する */
  close(): Promise<void>;
}

type Reply = { rows: Record<string, unknown>[] } | { error: string };

/*
 * 別のスレッドで動かすコード（CommonJS）。文を 1 つ受けるたびに、その接続を書けないようにしてから
 * 流し、行を列の名前の付いたただのオブジェクトにして返す。接続は最初の文で開き、開き直されても書けない
 * ように、書けない設定は文ごとに当てる（設定は接続ごとのもので、1 回で済ませると開き直したあとに外れる）
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const { createClient } = require(workerData.libsqlPath);
let client;
parentPort.on("message", async ({ sql, args }) => {
  try {
    client ??= createClient({ url: workerData.url, concurrency: 1, timeout: 5000 });
    await client.execute("PRAGMA query_only = ON");
    const result = await client.execute({ sql, args });
    const rows = result.rows.map((row) =>
      Object.fromEntries(result.columns.map((column, index) => [column, row[index]])),
    );
    parentPort.postMessage({ rows });
  } catch (error) {
    parentPort.postMessage({ error: String(error?.message ?? error) });
  }
});
`;

/**
 * 重い読み取りを流す入口を作る。url は libsql の形のファイル（file:/data/sendo.db）。別のスレッドは、
 * 最初の文で起こす。文は 1 つずつ流し（CPU を食い合わせない）、前の文が終わるまで次の文は待つ。別の
 * スレッドが落ちたら、そのとき流していた文を失敗にし、次の文で起こし直す
 */
export function createWorkerHeavyRead(url: string): WorkerHeavyRead {
  const dialect = new SQLiteAsyncDialect();
  const libsqlPath = createRequire(import.meta.url).resolve("@libsql/client");
  let worker: Worker | undefined;
  let current: { resolve(reply: Reply): void; reject(error: Error): void } | undefined;
  let tail: Promise<unknown> = Promise.resolve();
  let closed = false;

  const start = (): Worker => {
    const started = new Worker(WORKER_SOURCE, { eval: true, workerData: { url, libsqlPath } });
    // 別のスレッドだけが残っていても、プロセスは終われるようにする
    started.unref();
    started.on("message", (reply: Reply) => {
      const waiting = current;
      current = undefined;
      waiting?.resolve(reply);
    });
    const fail = (error: Error) => {
      if (worker === started) worker = undefined;
      const waiting = current;
      current = undefined;
      waiting?.reject(error);
    };
    started.on("error", fail);
    started.on("exit", (code) => fail(new Error(`heavy read worker exited (code ${code})`)));
    return started;
  };

  const run = async (sql: string, params: unknown[]): Promise<Record<string, unknown>[]> => {
    if (closed) throw new Error("heavy read is closed");
    worker ??= start();
    const target = worker;
    const reply = await new Promise<Reply>((resolve, reject) => {
      current = { resolve, reject };
      target.postMessage({ sql, args: params });
    });
    if ("error" in reply) throw new Error(reply.error);
    return reply.rows;
  };

  return {
    all<T>(query: SQL): Promise<T[]> {
      const { sql, params } = dialect.sqlToQuery(query);
      const result = tail.then(
        () => run(sql, params),
        () => run(sql, params),
      );
      tail = result.catch(() => undefined);
      return result as Promise<T[]>;
    },
    async close() {
      closed = true;
      const running = worker;
      worker = undefined;
      await running?.terminate();
    },
  };
}
