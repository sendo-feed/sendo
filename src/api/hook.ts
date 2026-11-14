import type { Hook } from "@hono/zod-openapi";
import type { Env } from "hono";
import { errorBody } from "./schemas";

/** 入力の検証に失敗したら、共通のエラーの形で 400 を返す */
// biome-ignore lint/suspicious/noExplicitAny: Hook の型引数は、どのルートの入力も受けられるように広く取る
export const defaultHook: Hook<any, Env, string, unknown> = (result, c) => {
  if (!result.success) {
    const message = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    return c.json(errorBody("invalid_request", message), 400);
  }
  return undefined;
};
