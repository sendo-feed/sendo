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
import { BUSY_TIMEOUT_MS } from "./database";

export interface WorkerHeavyRead extends HeavyRead {
  /**
   * 別のスレッドを止める。流している文は終わるのを待ち、待っている文と新しい文は失敗する。スレッドは接続を
   * 閉じてから自分で終わる
   */
  close(): Promise<void>;
}

type Reply = { id: number } & ({ rows: Record<string, unknown>[] } | { error: string });

/*
 * 別のスレッドで動かすコード（CommonJS）。文を 1 つ受けるたびに、その接続を書けないようにしてから
 * 流し、行を列の名前の付いたただのオブジェクトにして返す。接続は最初の文で開き、開き直されても書けない
 * ように、書けない設定は文ごとに当てる（設定は接続ごとのもので、1 回で済ませると開き直したあとに外れる）。
 * 止めるときは、接続を閉じ、受け口を閉じて自分で終わる
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const { createClient } = require(workerData.libsqlPath);
let client;
parentPort.on("message", async ({ id, sql, args, close }) => {
  if (close) {
    client?.close();
    parentPort.close();
    return;
  }
  try {
    client ??= createClient({ url: workerData.url, concurrency: 1, timeout: workerData.busyTimeout });
    await client.execute("PRAGMA query_only = ON");
    const result = await client.execute({ sql, args });
    const rows = result.rows.map((row) =>
      Object.fromEntries(result.columns.map((column, index) => [column, row[index]])),
    );
    parentPort.postMessage({ id, rows });
  } catch (error) {
    parentPort.postMessage({ id, error: String(error?.message ?? error) });
  }
});
`;

/**
 * 重い読み取りを流す入口を作る。url は libsql の形のファイル（file:/data/sendo.db）。別のスレッドは、
 * 最初の文で起こす。文は 1 つずつ流し（CPU を食い合わせない）、前の文が終わるまで次の文は待つ。別の
 * スレッドが落ちたら、そのとき流していた文を失敗にし、次の文で起こし直す
 */
export function createWorkerHeavyRead(
  url: string,
  options: {
    /** 起こした別のスレッドを受け取る（テストで、落ちたときを起こすのに使う） */
    onStart?: (worker: Worker) => void;
  } = {},
): WorkerHeavyRead {
  const dialect = new SQLiteAsyncDialect();
  const libsqlPath = createRequire(import.meta.url).resolve("@libsql/client");
  let worker: Worker | undefined;
  /** 流している読み取り。どのスレッドに送った何番目の文かで照らす（落ちたスレッドの遅れたイベントや返事を、ほかの読み取りに当てない） */
  let current:
    | { worker: Worker; id: number; resolve(reply: Reply): void; reject(error: Error): void }
    | undefined;
  let nextId = 0;
  let tail: Promise<unknown> = Promise.resolve();
  let closed = false;

  const start = (): Worker => {
    const started = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { url, libsqlPath, busyTimeout: BUSY_TIMEOUT_MS },
    });
    // 別のスレッドだけが残っていても、プロセスは終われるようにする
    started.unref();
    started.on("message", (reply: Reply) => {
      if (current?.worker !== started || current.id !== reply.id) return;
      const waiting = current;
      current = undefined;
      waiting.resolve(reply);
    });
    const fail = (error: Error) => {
      if (worker === started) worker = undefined;
      if (current?.worker !== started) return;
      const waiting = current;
      current = undefined;
      waiting.reject(error);
    };
    started.on("error", fail);
    started.on("exit", (code) => fail(new Error(`heavy read worker exited (code ${code})`)));
    return started;
  };

  const run = async (sql: string, params: unknown[]): Promise<Record<string, unknown>[]> => {
    if (closed) throw new Error("heavy read is closed");
    if (!worker) {
      worker = start();
      options.onStart?.(worker);
    }
    const target = worker;
    const id = nextId++;
    const reply = await new Promise<Reply>((resolve, reject) => {
      current = { worker: target, id, resolve, reject };
      target.postMessage({ id, sql, args: params });
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
      // 流している文が終わるのを待つ。文の途中でスレッドを止める（terminate）と、libsql のネイティブの結びが
      // panic し、プロセスごと落ちる。待っている文は、順に closed で失敗する
      await tail;
      const running = worker;
      worker = undefined;
      if (!running) return;
      const exited = new Promise<void>((resolve) => running.once("exit", () => resolve()));
      running.postMessage({ close: true });
      await exited;
    },
  };
}
