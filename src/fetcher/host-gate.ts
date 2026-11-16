/**
 * 同じホストへの取得を、1 つずつ順に動かす（docs/decisions/content.md の 17）。
 *
 * - 同じホストの取得は、同時に 1 つだけ。前の取得が終わってから intervalMs 空けて、次を始める
 * - 待っている取得は、並んだ順に動かす。ただし interactive（読者が開いたとき）は、background
 *   （抜く仕事）より前に並べる。並んだあとで interactive に上げることもできる（GateTicket.promote）
 * - 数えるのはプロセスのメモリ。コンテナ版は 1 つのプロセスで動く（docs/decisions/container.md の 7）
 *   ので、それで全体を絞れる
 */

export type GatePriority = "interactive" | "background";

/**
 * 順番を待つ取得の札。待っている間に promote すると、interactive の位置へ並び直す
 * （抜く仕事が待っている記事を、読者が開いたとき）
 */
export class GateTicket {
  #priority: GatePriority;
  /** 並んでいる間だけ、HostGate が入れる */
  onPromote: (() => void) | undefined;

  constructor(priority: GatePriority) {
    this.#priority = priority;
  }

  get priority(): GatePriority {
    return this.#priority;
  }

  promote(): void {
    if (this.#priority === "interactive") return;
    this.#priority = "interactive";
    this.onPromote?.();
  }
}

type Waiter = { ticket: GateTicket; resolve: () => void };

type HostState = {
  /** 取得が動いているか（順番を渡している間も含む） */
  busy: boolean;
  waiters: Waiter[];
  /** 前の取得が終わった時刻 */
  lastEndAt: number;
};

/** 使い終わったホストの記録を見直す数。これを超えたら、間隔が過ぎたホストの記録を捨てる */
const SWEEP_THRESHOLD = 1000;

export class HostGate {
  readonly #hosts = new Map<string, HostState>();
  readonly #intervalMs: number;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(options: {
    intervalMs: number;
    /** テストで差し替える */
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  }) {
    this.#intervalMs = options.intervalMs;
    this.#now = options.now ?? (() => Date.now());
    this.#sleep =
      options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }

  /** ホストの順番を待ってから task を動かす。task が終われば（失敗しても）、次に順番を渡す */
  async run<T>(
    host: string,
    ticket: GateTicket | GatePriority,
    task: () => Promise<T>,
  ): Promise<T> {
    const state = await this.#acquire(
      host,
      typeof ticket === "string" ? new GateTicket(ticket) : ticket,
    );
    try {
      return await task();
    } finally {
      this.#release(state);
    }
  }

  async #acquire(host: string, ticket: GateTicket): Promise<HostState> {
    let state = this.#hosts.get(host);
    if (state === undefined) {
      this.#sweep();
      state = { busy: false, waiters: [], lastEndAt: Number.NEGATIVE_INFINITY };
      this.#hosts.set(host, state);
    }
    if (state.busy) {
      const { waiters } = state;
      // 前の取得から順番を渡されるまで待つ（渡されたときも busy のまま）
      await new Promise<void>((resolve) => {
        const waiter = { ticket, resolve };
        enqueue(waiters, waiter);
        ticket.onPromote = () => {
          const index = waiters.indexOf(waiter);
          if (index === -1) return;
          waiters.splice(index, 1);
          enqueue(waiters, waiter);
        };
      });
      ticket.onPromote = undefined;
    } else {
      state.busy = true;
    }
    const wait = state.lastEndAt + this.#intervalMs - this.#now();
    if (wait > 0) await this.#sleep(wait);
    return state;
  }

  #release(state: HostState): void {
    state.lastEndAt = this.#now();
    const next = state.waiters.shift();
    if (next) next.resolve();
    else state.busy = false;
  }

  /** 動いておらず、間隔も過ぎたホストの記録を捨てる（記録が増え続けないように） */
  #sweep(): void {
    if (this.#hosts.size < SWEEP_THRESHOLD) return;
    const now = this.#now();
    for (const [host, state] of this.#hosts) {
      if (!state.busy && state.lastEndAt + this.#intervalMs <= now) this.#hosts.delete(host);
    }
  }
}

/** 並ぶ。interactive は、最初の background の前に入れる（interactive どうしは来た順） */
function enqueue(waiters: Waiter[], waiter: Waiter): void {
  const index =
    waiter.ticket.priority === "interactive"
      ? waiters.findIndex((w) => w.ticket.priority === "background")
      : -1;
  if (index === -1) waiters.push(waiter);
  else waiters.splice(index, 0, waiter);
}
