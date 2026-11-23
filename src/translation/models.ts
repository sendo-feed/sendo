/**
 * 翻訳に使うモデルを、段階ごとに Models API の一覧から選ぶ（docs/decisions/translation.md の 9）。状態は
 * プロセスのメモリーにだけ持つ（外したモデルも、再起動で戻る）。
 *
 * - 一覧は起動時と 1 日 1 回取り（すべての段階で同じ一覧を使う）、ID が系列の頭で始まり、その段階の
 *   思考量を受け付けるもののうち、作られた日がいちばん新しいものを選ぶ
 * - 一覧を取れなければ、前に選んだもの（なければコードの既定）を使う
 * - 固定のモデル（env のモデルの ID）があれば、一覧を見ずにそれを使う
 * - モデルを外す判断はモデルごとに持ち、段階の間で分け合う（ModelHealth）。一覧から選んだモデルで、
 *   まだ 1 件も訳せていないうちに、要求の形の誤り（invalid_request_error。支払いの問題の billing_error
 *   などは数えない）が続けて MAX_INVALID_REQUESTS 件起きたら、そのモデルを外し、どの段階でも次に新しい
 *   ものを使う。間にほかの結果が入ったら、数え直す
 */

/** 一覧を取り直す間隔 */
export const MODEL_REFRESH_MS = 24 * 60 * 60 * 1000;

/** 一覧を取れなかったときに、取り直すまでの間隔（失敗のたびに、毎回の翻訳で頼まない） */
export const MODEL_RETRY_MS = 60 * 60 * 1000;

/** モデルを外すまでの、続けて起きた要求の形の誤りの数 */
export const MAX_INVALID_REQUESTS = 3;

export interface ModelInfo {
  id: string;
  /** 作られた日（ミリ秒） */
  createdAt: number;
  /** 受け付ける思考量（一覧の capabilities。分からなければ空） */
  efforts: readonly string[];
}

export interface ModelSelector {
  /** 次の要求に使うモデル。一覧を取る時期なら、取ってから決める */
  current(): Promise<string>;
  /** そのモデルで訳せた */
  succeeded(model: string): void;
  /**
   * そのモデルへの要求が、要求の形の誤り（400 の invalid_request_error）で断られた。外す判断に数えたら
   * true（まだ 1 件も訳せていない、この段階が一覧から選んだモデルで、この段階に次の候補がある）。一度
   * 訳せたモデル、固定のモデル、既定のモデル、次の候補がないモデルは false（外せないので、記事の中身による
   * 誤りとみなす）
   */
  invalidRequest(model: string): boolean;
  /** そのモデルへの要求が、ほかの形で終わった（拒否、読めない応答、ほかの失敗）。続けて数えない */
  otherOutcome(model: string): void;
}

/**
 * Models API の一覧を、決まった間隔で取り直して持つ。すべての段階のモデル選びで使い回し、一覧は 1 回の
 * 取り直しで 1 度だけ取る
 */
export interface ModelCatalog {
  /** いま持っている一覧。取り直す時期なら、取ってから返す。一度も取れていなければ null */
  list(): Promise<readonly ModelInfo[] | null>;
}

export function createModelCatalog(input: {
  listModels: () => Promise<ModelInfo[]>;
  now: () => number;
}): ModelCatalog {
  let models: readonly ModelInfo[] | null = null;
  /** 次に一覧を取る時刻 */
  let nextRefresh = 0;
  let refreshing: Promise<void> | null = null;

  const refresh = async () => {
    try {
      models = await input.listModels();
      nextRefresh = input.now() + MODEL_REFRESH_MS;
    } catch (error) {
      // 前に取れたもの（なければ、選ぶ側の既定）を使い続ける
      console.warn("could not list the translation models", {
        error: error instanceof Error ? error.message : String(error),
      });
      nextRefresh = input.now() + MODEL_RETRY_MS;
    }
  };

  return {
    async list() {
      if (input.now() >= nextRefresh) {
        refreshing ??= refresh().finally(() => {
          refreshing = null;
        });
        await refreshing;
      }
      return models;
    },
  };
}

/**
 * モデルごとの結果（訳せたか、続けて起きた要求の形の誤りの数、外したか）。同じモデルを 2 つの段階で
 * 使っても 1 つに数える（docs/decisions/translation.md の 9）
 */
export interface ModelHealth {
  readonly excluded: ReadonlySet<string>;
  succeeded(model: string): void;
  otherOutcome(model: string): void;
  /**
   * 要求の形の誤りを 1 つ数える（一度でも訳せたモデルは数えない）。続けて MAX_INVALID_REQUESTS 件に
   * なって外したら true
   */
  invalidRequest(model: string): boolean;
  /** 一度でも訳せたか */
  hasSucceeded(model: string): boolean;
}

export function createModelHealth(): ModelHealth {
  const excluded = new Set<string>();
  const usage = new Map<string, { succeeded: boolean; invalid: number }>();
  const stateOf = (model: string) => {
    let state = usage.get(model);
    if (state === undefined) {
      state = { succeeded: false, invalid: 0 };
      usage.set(model, state);
    }
    return state;
  };
  return {
    excluded,
    succeeded(model) {
      const state = stateOf(model);
      state.succeeded = true;
      state.invalid = 0;
    },
    otherOutcome(model) {
      const state = usage.get(model);
      if (state !== undefined) state.invalid = 0;
    },
    invalidRequest(model) {
      const state = stateOf(model);
      if (state.succeeded) return false;
      state.invalid += 1;
      if (state.invalid < MAX_INVALID_REQUESTS || excluded.has(model)) return false;
      excluded.add(model);
      return true;
    },
    hasSucceeded: (model) => usage.get(model)?.succeeded ?? false,
  };
}

export function createModelSelector(input: {
  /** 選ぶモデルの ID の頭（"claude-sonnet-" など） */
  prefix: string;
  /** この段階の思考量。受け付けないモデルは選ばない */
  effort: string;
  /** 一覧を一度も取れていないときのモデル */
  defaultModel: string;
  /** 固定のモデル（env）。あれば一覧を見ない */
  pinned?: string;
  catalog: ModelCatalog;
  health: ModelHealth;
}): ModelSelector {
  const { health } = input;
  const pinned = input.pinned;
  if (pinned !== undefined) {
    // 固定のモデルはこの段階では外さない（要求の形の誤りは記事の中身によるものとみなす）。モデルごとの
    // 結果には数え、ほかの段階が同じモデルを一覧から選んでいれば、その段階では外れる
    return {
      current: async () => pinned,
      succeeded: (model) => health.succeeded(model),
      invalidRequest(model) {
        recordInvalid(health, model);
        return false;
      },
      otherOutcome: (model) => health.otherOutcome(model),
    };
  }
  /** 一覧から選べるモデル（新しい順） */
  let candidates: string[] = [];
  /** candidates を作った一覧（取り直したら作り直す） */
  let seen: readonly ModelInfo[] | null = null;
  /** 前に選んだもの */
  let chosen = input.defaultModel;

  return {
    async current() {
      const models = await input.catalog.list();
      if (models !== null && models !== seen) {
        seen = models;
        candidates = models
          .filter((model) => model.id.startsWith(input.prefix))
          .filter((model) => model.efforts.includes(input.effort))
          .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1))
          .map((model) => model.id);
      }
      // ほかの段階で外したモデルも避ける。候補がすべて外れていれば、前に選んだものを使い続ける
      const next = candidates.find((id) => !health.excluded.has(id));
      if (next !== undefined) chosen = next;
      return chosen;
    },
    succeeded: (model) => health.succeeded(model),
    otherOutcome: (model) => health.otherOutcome(model),
    invalidRequest(model) {
      // 一度でも訳せたモデルは、記事の中身による誤りとみなして外さない。一覧から選んだモデルだけを
      // 外す（既定のモデルは外さない）。この段階に次に新しいものがなければ、外さずに使い続ける
      // （モデルごとの結果には数える。外れても、この段階では候補がないので使い続ける）
      const next = candidates.find((id) => id !== model && !health.excluded.has(id));
      const counted =
        !health.hasSucceeded(model) && candidates.includes(model) && next !== undefined;
      recordInvalid(health, model);
      return counted;
    },
  };
}

/** 要求の形の誤りをモデルごとに数え、外したらログに出す */
function recordInvalid(health: ModelHealth, model: string): void {
  if (health.invalidRequest(model)) {
    console.warn("excluded a translation model after repeated invalid requests", { model });
  }
}
