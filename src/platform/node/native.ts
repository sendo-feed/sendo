/**
 * Rust の処理（crates/）を、napi-rs のネイティブのモジュールとして読み込む
 * （docs/decisions/tech-stack.md の 5）。読み込むのは src/platform/node/ だけ。
 *
 * モジュールは pnpm build:native で native/sendo.node に作る（イメージでは /app/native/sendo.node）。
 */
import { createRequire } from "node:module";
import type { ExtractedPage, PageContentExtractor } from "..";

/** crates/node が出す関数（napi-rs が名前を camelCase にする） */
export interface NativeModule {
  extractPageContent(
    bytes: Uint8Array,
    contentType: string | null,
    url: string,
  ): Promise<ExtractedPage | null>;
}

/** ネイティブのモジュールを読み込む。なければ例外 */
export function loadNativeModule(file: string): NativeModule {
  return createRequire(import.meta.url)(file) as NativeModule;
}

/** 記事のページから本文を抜く（docs/decisions/content.md の 11）。重い処理はスレッドプールで動く */
export function createPageContentExtractor(native: NativeModule): PageContentExtractor {
  return {
    extract: ({ bytes, contentType, url }) => native.extractPageContent(bytes, contentType, url),
  };
}
