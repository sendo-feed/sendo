/**
 * Rust の処理（crates/）を、napi-rs のネイティブのモジュールとして読み込む
 * （docs/decisions/tech-stack.md の 5）。読み込むのは src/platform/node/ だけ。
 *
 * モジュールは pnpm build:native で native/sendo.node に作る（イメージでは /app/native/sendo.node）。
 */
import { createRequire } from "node:module";
import type {
  ExtractedPage,
  LanguageDetectionResult,
  LanguageDetector,
  PageContentExtractor,
  PageImageLink,
} from "..";

interface MediaResult {
  links: PageImageLink[];
  candidates: string[];
  eligible: boolean;
  matches: boolean;
  html: string;
}

/** crates/node が出す関数（napi-rs が名前を camelCase にする） */
export interface NativeModule {
  languageDetectorInfo(): { detector: string; pipelineRevision: number };
  detectArticleLanguage(html: string): Promise<LanguageDetectionResult>;
  pageImageLinks(html: string, url: string): Promise<MediaResult>;
  pageImageCandidates(
    bytes: Uint8Array,
    contentType: string | null,
    url: string,
  ): Promise<MediaResult>;
  comparePageImages(thumbnail: Uint8Array, candidate: Uint8Array | null): Promise<MediaResult>;
  replacePageImage(
    html: string,
    thumbnail: string,
    target: string,
    replacement: string,
  ): Promise<MediaResult>;
  extractPageContent(
    bytes: Uint8Array,
    contentType: string | null,
    url: string,
  ): Promise<ExtractedPage | null>;
}

export function createLanguageDetector(native: NativeModule): LanguageDetector {
  return {
    ...native.languageDetectorInfo(),
    detect: (html) => native.detectArticleLanguage(html),
  };
}

/** ネイティブのモジュールを読み込む。なければ例外 */
export function loadNativeModule(file: string): NativeModule {
  return createRequire(import.meta.url)(file) as NativeModule;
}

/** 記事のページから本文を抜く（docs/decisions/content.md の 11）。重い処理はスレッドプールで動く */
export function createPageContentExtractor(native: NativeModule): PageContentExtractor {
  return {
    images: {
      links: async (html, url) => (await native.pageImageLinks(html, url)).links,
      candidates: async ({ bytes, contentType, url }) =>
        (await native.pageImageCandidates(bytes, contentType, url)).candidates,
      compare: (thumbnail, candidate) => native.comparePageImages(thumbnail, candidate),
      replace: async (html, link, replacement) =>
        (await native.replacePageImage(html, link.thumbnail, link.target, replacement)).html,
    },
    extract: ({ bytes, contentType, url }) => native.extractPageContent(bytes, contentType, url),
  };
}
