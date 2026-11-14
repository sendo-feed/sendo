/**
 * OpenAPI の定義を spec/openapi.json に書き出す。
 *
 *   pnpm openapi:generate
 *
 * sendo-reader は、このファイルから API の型を作る（openapi-typescript）。CI は、書き出した
 * ものとコミットしたものが一致するかを確かめる（API を変えたら、書き出してコミットする）。
 *
 * 定義を作るだけなので、DB やキューには触れない。触れようとしたら、すぐに失敗させる。
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApi, OPENAPI_CONFIG } from "../src/api";
import type { Platform } from "../src/platform";

/** 取り出すことはできるが、呼んだら失敗する値（ルーターは組み立てるときに platform.db などを取り出す） */
function unavailable(name: string): unknown {
  return new Proxy(() => {}, {
    get: (_target, prop) => unavailable(`${name}.${String(prop)}`),
    apply: () => {
      throw new Error(`${name} is not available while generating the spec`);
    },
  });
}

const document = createApi(unavailable("platform") as Platform).getOpenAPI31Document(
  OPENAPI_CONFIG,
);

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const output = path.join(root, "spec", "openapi.json");
writeFileSync(output, `${JSON.stringify(document, null, 2)}\n`);
console.log(
  `wrote ${path.relative(root, output)} (${Object.keys(document.paths ?? {}).length} paths)`,
);
