import path from "node:path";
import type { Worker } from "node:worker_threads";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { createWorkerHeavyRead } from "../../../src/platform/node/heavy-read";
import { testDatabase, testDb } from "../../db";

/*
 * 重い読み取り（docs/decisions/container.md の 5）。テストの DB のファイルを、別のスレッドで開いて読む
 */

const url = `file:${path.join(testDatabase.directory, "sendo.db")}`;
const heavyRead = createWorkerHeavyRead(url);
afterAll(() => heavyRead.close());

/** 1 秒ほどかかる読み取り */
const slowCount = sql`with recursive c(x) as (select 1 union all select x + 1 from c where x < 3000000)
  select count(*) as n from c`;

describe("重い読み取り", () => {
  it("別のスレッドの接続で読み、列の名前の付いた行を返す。主の接続が書いたものも読める", async () => {
    await testDb.exec("CREATE TABLE heavy_read_rows (id INTEGER PRIMARY KEY, name TEXT)");
    await testDb.exec("INSERT INTO heavy_read_rows (id, name) VALUES (1, 'a'), (2, 'b')");
    const rows = await heavyRead.all(
      sql`select id, name from heavy_read_rows where id >= ${1} order by id`,
    );
    expect(rows).toEqual([
      { id: 1, name: "a" },
      { id: 2, name: "b" },
    ]);
    await testDb.exec("INSERT INTO heavy_read_rows (id, name) VALUES (3, 'c')");
    expect(await heavyRead.all(sql`select count(*) as n from heavy_read_rows`)).toEqual([{ n: 3 }]);
  });

  it("書き込む文は失敗し、DB は変わらない", async () => {
    await testDb.exec("CREATE TABLE heavy_read_writes (id INTEGER PRIMARY KEY)");
    await expect(heavyRead.all(sql`insert into heavy_read_writes (id) values (1)`)).rejects.toThrow(
      /readonly|read-only|query_only/i,
    );
    expect(await testDb.prepare("SELECT count(*) AS n FROM heavy_read_writes").first("n")).toBe(0);
  });

  it("流している間も主のスレッドは止まらず、主の接続で書ける", async () => {
    // 別のスレッドと接続を先に用意しておく
    await heavyRead.all(sql`select 1 as one`);
    let maxLag = 0;
    let last = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      maxLag = Math.max(maxLag, now - last - 10);
      last = now;
    }, 10);
    try {
      const started = performance.now();
      const reading = heavyRead.all<{ n: number }>(slowCount);
      await testDb.exec("CREATE TABLE IF NOT EXISTS heavy_read_during (id INTEGER)");
      await testDb.exec("INSERT INTO heavy_read_during (id) VALUES (1)");
      expect(await reading).toEqual([{ n: 3_000_000 }]);
      const elapsed = performance.now() - started;
      // 主のスレッドで流せば、読み取りの時間だけ止まる。止まった最大は、それよりずっと短い
      expect(elapsed).toBeGreaterThan(200);
      expect(maxLag).toBeLessThan(elapsed / 4);
    } finally {
      clearInterval(timer);
    }
    expect(await testDb.prepare("SELECT count(*) AS n FROM heavy_read_during").first("n")).toBe(1);
  });

  it("重なった読み取りは 1 つずつ、受けた順に流す", async () => {
    const order: string[] = [];
    const first = heavyRead.all(slowCount).then(() => order.push("first"));
    const second = heavyRead.all(sql`select 1 as one`).then(() => order.push("second"));
    await Promise.all([first, second]);
    expect(order).toEqual(["first", "second"]);
  });

  it("文が失敗したら、その読み取りだけを失敗にし、次の読み取りは流す", async () => {
    await expect(heavyRead.all(sql`select * from no_such_table`)).rejects.toThrow(/no_such_table/);
    expect(await heavyRead.all(sql`select 1 as one`)).toEqual([{ one: 1 }]);
  });

  it("別のスレッドが落ちたら流していた読み取りだけを失敗にし、待っていた読み取りは起こし直したスレッドで流す。落ちたスレッドの遅れたイベントと返事はほかの読み取りに当てない", async () => {
    const workers: Worker[] = [];
    const own = createWorkerHeavyRead(url, { onStart: (worker) => workers.push(worker) });
    try {
      await own.all(sql`select 1 as one`);
      const first = own.all(slowCount);
      const second = own.all(sql`select ${"b"} as who`);
      const third = own.all(sql`select ${"c"} as who`);
      // 1 つ目が別のスレッドに送られてから、捕まえていない例外で落ちたときを起こす（error が来て、exit は
      // 別のタスクで遅れて来る）
      await new Promise((resolve) => setTimeout(resolve, 0));
      const [crashed] = workers;
      if (!crashed) throw new Error("worker is not started");
      const lateReply = new Promise((resolve) => crashed.once("message", resolve));
      crashed.emit("error", new Error("boom"));
      await expect(first).rejects.toThrow("boom");
      // 待っていた読み取りが起こし直したスレッドに送られてから、落ちたスレッドの exit が届く
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(workers).toHaveLength(2);
      crashed.emit("exit", 1);
      expect(await second).toEqual([{ who: "b" }]);
      expect(await third).toEqual([{ who: "c" }]);
      // 落ちたスレッドが流していた文の返事が遅れて届いても、ほかの読み取りに当てない
      const fourth = own.all(slowCount);
      await lateReply;
      expect(await fourth).toEqual([{ n: 3_000_000 }]);
      expect(workers).toHaveLength(2);
      await crashed.terminate();
    } finally {
      await own.close();
    }
  });

  it("止めるときは流している読み取りが終わるのを待ち、待っていた読み取りと新しい読み取りは失敗する", async () => {
    const workers: Worker[] = [];
    const own = createWorkerHeavyRead(url, { onStart: (worker) => workers.push(worker) });
    await own.all(sql`select 1 as one`);
    const running = own.all(slowCount);
    const waiting = own.all(sql`select 1 as one`);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const exited = new Promise((resolve) => workers[0]?.once("exit", resolve));
    await own.close();
    // 流している文の途中でスレッドを止めない（止めると libsql が落ちる）。スレッドは自分で終わる
    expect(await running).toEqual([{ n: 3_000_000 }]);
    expect(await exited).toBe(0);
    await expect(waiting).rejects.toThrow(/closed/);
    await expect(own.all(sql`select 1 as one`)).rejects.toThrow(/closed/);
  });
});
