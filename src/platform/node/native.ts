/**
 * Rust の処理（crates/）を、napi-rs のネイティブのモジュールとして読み込む
 * （docs/decisions/tech-stack.md の 5）。読み込むのは src/platform/node/ だけ。
 *
 * モジュールは pnpm build:native で native/sendo.node に作る（イメージでは /app/native/sendo.node）。
 */
import { createRequire } from "node:module";
import type {
  AnalysisCandidate,
  ArticleAnalysisInput,
  ArticleAnalyzer,
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
  lead: string[];
  later: string[];
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
  pageLeadImages(html: string, url: string): Promise<MediaResult>;
  samePageImages(image: Uint8Array, other: Uint8Array): Promise<MediaResult>;
  removePageImage(html: string, src: string, url: string): Promise<MediaResult>;
  extractPageContent(
    bytes: Uint8Array,
    contentType: string | null,
    url: string,
  ): Promise<ExtractedPage | null>;
  analysisInfo(): { candidateRevision: number; embeddingRevision: number; dimension: number };
  loadEmbeddingModel(tokenizer: Uint8Array, model: Uint8Array, config: Uint8Array): Promise<void>;
  analyzeArticle(input: ArticleAnalysisInput): Promise<{
    candidates?: AnalysisCandidate[] | null;
    embedding?: Float32Array | null;
  }>;
  embedText(text: string): Promise<Float32Array | null>;
}

/** 埋め込みのモデルのファイル（docs/decisions/article-analysis.md の 6） */
export interface EmbeddingModelFiles {
  tokenizer: Uint8Array;
  model: Uint8Array;
  config: Uint8Array;
}

/**
 * 埋め込みのモデルを読み込み、記事を解析する実装を作る。読み込めなければ例外
 * （docs/decisions/container.md の 2）
 */
export async function createArticleAnalyzer(
  native: NativeModule,
  files: EmbeddingModelFiles,
): Promise<ArticleAnalyzer> {
  await native.loadEmbeddingModel(files.tokenizer, files.model, files.config);
  return {
    ...native.analysisInfo(),
    analyze: async (input) => {
      const result = await native.analyzeArticle({ ...input, categories: [...input.categories] });
      return {
        ...(input.candidates ? { candidates: result.candidates ?? [] } : {}),
        ...(input.embedding ? { embedding: result.embedding ?? null } : {}),
      };
    },
    embedText: (text) => native.embedText(text),
  };
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
      leadImages: async (html, url) => {
        const { lead, later } = await native.pageLeadImages(html, url);
        return { lead, later };
      },
      samePicture: async (image, other) => (await native.samePageImages(image, other)).matches,
      removeImage: async (html, src, url) => (await native.removePageImage(html, src, url)).html,
    },
    extract: ({ bytes, contentType, url }) => native.extractPageContent(bytes, contentType, url),
  };
}
