import { describe, expect, it } from "vitest";
import { GateTicket, HostGate } from "../../src/fetcher/host-gate";

/*
 * 同じホストへの取得を 1 つずつにする（docs/decisions/content.md の 17）。時計と待ちを差し替えて、
 * 実際には待たずに確かめる。
 */

/** 差し替えた時計。sleep は、その分だけ時計を進めて、記録する */
function fakeClock() {
  let now = 1_000_000;
  const sleeps: number[] = [];
  return {
    now: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
    advance: (ms: number) => {
      now += ms;
    },
    sleeps,
  };
}

/** 外から終わらせられる仕事 */
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 待っている仕事を先へ進める */
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe("HostGate", () => {
  it("同じホストの仕事は、1 つずつ順に動かす", async () => {
    const clock = fakeClock();
    const gate = new HostGate({ intervalMs: 0, ...clock });
    const log: string[] = [];
    let running = 0;
    let most = 0;
    const tasks = [deferred(), deferred(), deferred()];
    const runs = tasks.map((task, i) =>
      gate.run("a.example", "background", async () => {
        running++;
        most = Math.max(most, running);
        log.push(`start ${i}`);
        await task.promise;
        log.push(`end ${i}`);
        running--;
      }),
    );
    await flush();
    expect(log).toEqual(["start 0"]);
    tasks[0]?.resolve();
    await flush();
    expect(log).toEqual(["start 0", "end 0", "start 1"]);
    tasks[1]?.resolve();
    tasks[2]?.resolve();
    await Promise.all(runs);
    expect(log).toEqual(["start 0", "end 0", "start 1", "end 1", "start 2", "end 2"]);
    expect(most).toBe(1);
  });

  it("違うホストの仕事は、待たずに並べて動かす", async () => {
    const clock = fakeClock();
    const gate = new HostGate({ intervalMs: 1000, ...clock });
    const a = deferred();
    const started: string[] = [];
    const runA = gate.run("a.example", "background", async () => {
      started.push("a");
      await a.promise;
    });
    const runB = gate.run("b.example", "background", async () => {
      started.push("b");
    });
    await runB;
    expect(started).toEqual(["a", "b"]);
    a.resolve();
    await runA;
    expect(clock.sleeps).toEqual([]);
  });

  it("前の仕事が終わってから、間隔を空けて次を始める", async () => {
    const clock = fakeClock();
    const gate = new HostGate({ intervalMs: 1000, ...clock });
    await gate.run("a.example", "background", async () => {});
    clock.advance(300);
    await gate.run("a.example", "background", async () => {});
    expect(clock.sleeps).toEqual([700]);

    // 間隔が過ぎていれば、待たない
    clock.advance(1000);
    await gate.run("a.example", "background", async () => {});
    expect(clock.sleeps).toEqual([700]);
  });

  it("順番を待っていた仕事も、前の仕事が終わってから間隔を空ける", async () => {
    const clock = fakeClock();
    const gate = new HostGate({ intervalMs: 1000, ...clock });
    const first = deferred();
    const starts: number[] = [];
    const runs = [
      gate.run("a.example", "background", async () => {
        starts.push(clock.now());
        await first.promise;
      }),
      gate.run("a.example", "background", async () => {
        starts.push(clock.now());
      }),
    ];
    await flush();
    clock.advance(5000);
    first.resolve();
    await Promise.all(runs);
    expect(starts).toEqual([1_000_000, 1_006_000]);
  });

  it("読者が開いたとき（interactive）は、抜く仕事（background）より前に並べる", async () => {
    const clock = fakeClock();
    const gate = new HostGate({ intervalMs: 0, ...clock });
    const first = deferred();
    const order: string[] = [];
    const run = (name: string, priority: "interactive" | "background") =>
      gate.run("a.example", priority, async () => {
        order.push(name);
        if (name === "job 0") await first.promise;
      });
    const runs = [
      run("job 0", "background"),
      run("job 1", "background"),
      run("job 2", "background"),
      run("reader 0", "interactive"),
      run("reader 1", "interactive"),
    ];
    await flush();
    first.resolve();
    await Promise.all(runs);
    // 動いている仕事は追い越さない。読者どうしは来た順
    expect(order).toEqual(["job 0", "reader 0", "reader 1", "job 1", "job 2"]);
  });

  it("待っている仕事を interactive に上げると、読者の位置へ並び直す", async () => {
    const gate = new HostGate({ intervalMs: 0, ...fakeClock() });
    const first = deferred();
    const order: string[] = [];
    const tickets = [0, 1, 2].map(() => new GateTicket("background"));
    const runs = tickets.map((ticket, i) =>
      gate.run("a.example", ticket, async () => {
        order.push(`job ${i}`);
        if (i === 0) await first.promise;
      }),
    );
    const reader = gate.run("a.example", "interactive", async () => {
      order.push("reader");
    });
    await flush();
    // job 2 を開いた読者がいる。先に並んだ読者は追い越さない
    tickets[2]?.promote();
    // 動いている仕事を上げても、何も変わらない
    tickets[0]?.promote();
    expect(tickets[2]?.priority).toBe("interactive");
    first.resolve();
    await Promise.all([...runs, reader]);
    expect(order).toEqual(["job 0", "reader", "job 2", "job 1"]);
  });

  it("動き終えた札を上げても、何も起きない", async () => {
    const gate = new HostGate({ intervalMs: 0, ...fakeClock() });
    const ticket = new GateTicket("background");
    await gate.run("a.example", ticket, async () => {});
    ticket.promote();
    expect(await gate.run("a.example", "background", async () => "ok")).toBe("ok");
  });

  it("仕事が失敗しても、次に順番を渡す", async () => {
    const clock = fakeClock();
    const gate = new HostGate({ intervalMs: 0, ...clock });
    const failing = gate.run("a.example", "background", async () => {
      throw new Error("boom");
    });
    const next = gate.run("a.example", "background", async () => "ok");
    await expect(failing).rejects.toThrow("boom");
    expect(await next).toBe("ok");
  });

  it("仕事の結果を返す", async () => {
    const gate = new HostGate({ intervalMs: 0, ...fakeClock() });
    expect(await gate.run("a.example", "interactive", async () => 42)).toBe(42);
  });
});
