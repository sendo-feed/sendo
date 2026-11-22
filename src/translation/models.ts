/**
 * 翻訳に使うモデルを、Models API の一覧から選ぶ（docs/decisions/translation.md の 9）。状態は
 * プロセスのメモリーにだけ持つ（外したモデルも、再起動で戻る）。
 *
 * - 一覧は起動時と 1 日 1 回取り（その場の翻訳と訳し直しで同じ一覧を使う）、ID が prefix で始まるもののうち、
 *   作られた日がいちばん新しいものを選ぶ
 * - 一覧を取れなければ、前に選んだもの（なければコードの既定）を使う
 * - 固定のモデル（env）があれば、一覧を見ずにそれを使う
 * - 一覧から選んだモデルで、まだ 1 件も訳せていないうちに、要求の形の誤り（invalid_request_error。
 *   支払いの問題の billing_error などは数えない）が続けて MAX_INVALID_REQUESTS 件起きたら、そのモデルを
 *   外し、次に新しいものを使う。間にほかの結果が入ったら、数え直す
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
}

export interface ModelSelector {
  /** 次の要求に使うモデル。一覧を取る時期なら、取ってから決める */
  current(): Promise<string>;
  /** そのモデルで訳せた */
  succeeded(model: string): void;
  /**
   * そのモデルへの要求が、要求の形の誤り（400 の invalid_request_error）で断られた。外す判断に数えたら
   * true（まだ 1 件も訳せていない、一覧から選んだモデルで、次の候補がある）。一度訳せたモデル、固定の
   * モデル、既定のモデル、次の候補がないモデルは false（外せないので、記事の中身による誤りとみなす）
   */
  invalidRequest(model: string): boolean;
  /** そのモデルへの要求が、ほかの形で終わった（拒否、読めない応答、ほかの失敗）。続けて数えない */
  otherOutcome(model: string): void;
}

/**
 * Models API の一覧を、決まった間隔で取り直して持つ。その場の翻訳（Sonnet）と訳し直し（Opus）の
 * モデル選びで使い回し、一覧は 1 回の取り直しで 1 度だけ取る
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

export function createModelSelector(input: {
  /** 選ぶモデルの ID の頭（"claude-sonnet-" など） */
  prefix: string;
  /** 一覧を一度も取れていないときのモデル */
  defaultModel: string;
  /** 固定のモデル（env）。あれば一覧を見ない */
  pinned?: string;
  catalog: ModelCatalog;
}): ModelSelector {
  const pinned = input.pinned;
  if (pinned !== undefined) {
    return {
      current: async () => pinned,
      succeeded() {},
      invalidRequest: () => false,
      otherOutcome() {},
    };
  }
  /** 一覧から選べるモデル（新しい順） */
  let candidates: string[] = [];
  /** candidates を作った一覧（取り直したら作り直す） */
  let seen: readonly ModelInfo[] | null = null;
  /** 前に選んだもの */
  let chosen = input.defaultModel;
  const excluded = new Set<string>();
  const usage = new Map<string, { succeeded: boolean; invalid: number }>();

  const choose = () => {
    const next = candidates.find((id) => !excluded.has(id));
    if (next !== undefined) chosen = next;
  };

  return {
    async current() {
      const models = await input.catalog.list();
      if (models !== null && models !== seen) {
        seen = models;
        candidates = models
          .filter((model) => model.id.startsWith(input.prefix))
          .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1))
          .map((model) => model.id);
        choose();
      }
      return chosen;
    },
    otherOutcome(model) {
      const state = usage.get(model);
      if (state !== undefined) state.invalid = 0;
    },
    succeeded(model) {
      const state = usage.get(model) ?? { succeeded: false, invalid: 0 };
      state.succeeded = true;
      state.invalid = 0;
      usage.set(model, state);
    },
    invalidRequest(model) {
      const state = usage.get(model) ?? { succeeded: false, invalid: 0 };
      usage.set(model, state);
      // 一度でも訳せたモデルは、記事の中身による誤りとみなして外さない。一覧から選んだモデルだけを
      // 外す（既定のモデルは外さない）。次に新しいものがなければ、外さずに使い続ける
      const next = candidates.find((id) => id !== model && !excluded.has(id));
      if (state.succeeded || !candidates.includes(model) || next === undefined) return false;
      state.invalid += 1;
      if (state.invalid < MAX_INVALID_REQUESTS || model !== chosen) return true;
      excluded.add(model);
      chosen = next;
      console.warn("excluded a translation model after repeated invalid requests", {
        model,
        next,
      });
      return true;
    },
  };
}
