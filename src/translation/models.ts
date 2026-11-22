/**
 * 翻訳に使うモデルを、Models API の一覧から選ぶ（docs/decisions/translation.md の 9）。状態は
 * プロセスのメモリーにだけ持つ（外したモデルも、再起動で戻る）。
 *
 * - 一覧は起動時と 1 日 1 回取り、ID が prefix で始まるもののうち、作られた日がいちばん新しいものを選ぶ
 * - 一覧を取れなければ、前に選んだもの（なければコードの既定）を使う
 * - 固定のモデル（env）があれば、一覧を見ずにそれを使う
 * - 一覧から選んだモデルで、まだ 1 件も訳せていないうちに、要求の形の誤りが続けて
 *   MAX_INVALID_REQUESTS 件起きたら、そのモデルを外し、次に新しいものを使う
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
  /** そのモデルへの要求が、要求の形の誤り（400 の invalid_request_error）で断られた */
  invalidRequest(model: string): void;
}

export function createModelSelector(input: {
  /** 選ぶモデルの ID の頭（"claude-sonnet-" など） */
  prefix: string;
  /** 一覧を一度も取れていないときのモデル */
  defaultModel: string;
  /** 固定のモデル（env）。あれば一覧を見ない */
  pinned?: string;
  listModels: () => Promise<ModelInfo[]>;
  now: () => number;
}): ModelSelector {
  const pinned = input.pinned;
  if (pinned !== undefined) {
    return { current: async () => pinned, succeeded() {}, invalidRequest() {} };
  }
  /** 一覧から選べるモデル（新しい順） */
  let candidates: string[] = [];
  /** 前に選んだもの */
  let chosen = input.defaultModel;
  /** 次に一覧を取る時刻 */
  let nextRefresh = 0;
  let refreshing: Promise<void> | null = null;
  const excluded = new Set<string>();
  const usage = new Map<string, { succeeded: boolean; invalid: number }>();

  const choose = () => {
    const next = candidates.find((id) => !excluded.has(id));
    if (next !== undefined) chosen = next;
  };

  const refresh = async () => {
    try {
      const models = await input.listModels();
      candidates = models
        .filter((model) => model.id.startsWith(input.prefix))
        .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1))
        .map((model) => model.id);
      choose();
      nextRefresh = input.now() + MODEL_REFRESH_MS;
    } catch (error) {
      // 前に選んだもの（なければ既定）を使い続ける
      console.warn("could not list the translation models", {
        error: error instanceof Error ? error.message : String(error),
      });
      nextRefresh = input.now() + MODEL_RETRY_MS;
    }
  };

  return {
    async current() {
      if (input.now() >= nextRefresh) {
        refreshing ??= refresh().finally(() => {
          refreshing = null;
        });
        await refreshing;
      }
      return chosen;
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
      // 一度でも訳せたモデルは、記事の中身による誤りとみなして外さない
      if (state.succeeded) return;
      state.invalid += 1;
      if (state.invalid < MAX_INVALID_REQUESTS || model !== chosen) return;
      // 一覧から選んだモデルだけを外す。次に新しいものがなければ、外さずに使い続ける
      const next = candidates.find((id) => id !== model && !excluded.has(id));
      if (!candidates.includes(model) || next === undefined) return;
      excluded.add(model);
      chosen = next;
      console.warn("excluded a translation model after repeated invalid requests", {
        model,
        next,
      });
    },
  };
}
