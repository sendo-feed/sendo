/**
 * 実行環境の緩衝層。
 *
 * DB、ファイル、外への取得、Rust のネイティブのモジュール、タイマーなど、実行環境の I/O をまとめる。
 * アプリ（api/、jobs/ など）は、ここのインターフェース越しに使い、テストでは差し替える。
 * 実装は platform/node/ にある（docs/decisions/container.md）。
 */
import type { SQL } from "drizzle-orm";
import type { Context } from "hono";
import type { Database } from "../db";
import type { ArticleCursor, ArticleListInput, InboxArticle } from "../db/inbox";
import type { SessionIdentity } from "../db/sessions";
import type { Job } from "../jobs/job";
import type { SyncNotifier } from "../lib/sync-notify";
import type { TranslationEffort } from "./config";

/** 重い処理を、API の応答と切り離して後で実行する */
export interface JobQueue {
  /**
   * 仕事を積む。runAt を指定すると、その時刻になるまで取り出さない。指定しなければ、すぐに取り出せる
   * （docs/decisions/jobs.md の 1）
   */
  enqueue(
    jobs: readonly Job[],
    options?: {
      runAt?: Date;
      /**
       * 同時に 1 本だけ動かす仕事（記事の解析の遡及）を、その枠に未着手の仕事も着手済みの仕事もないときだけ
       * 積む。定期実行が使う。枠のない仕事には使えない
       */
      onlyIfIdle?: boolean;
    },
  ): Promise<void>;
  enqueueDueDiscordFetches(now: Date, limit: number): Promise<number>;
}

/** 提供元に登録した、OAuth のクライアント */
export interface OAuthClient {
  clientId: string;
  clientSecret: string;
}

/** セルフホストする人が Discord Developer Portal で登録したアプリ */
export interface DiscordConfig extends OAuthClient {
  botToken: string;
  redirectUri: string;
  /** Bot の読み取りを枠に合わせて送る。通信の期限も送り始めるときに決める。 */
  botFetch?: typeof fetch;
}

/**
 * Sendo が OAuth の認可サーバーになるための設定（docs/decisions/mcp.md の 3、4）。
 * Claude.ai や ChatGPT などが、OAuth で /mcp につなぐのに使う
 */
export interface OAuthServerConfig {
  /**
   * 発行者（issuer）。Sendo を外から呼ぶときのオリジン（https://sendo.example.com）。
   * 許可の画面の API は sendo-reader から中継されて届き、リクエストの URL からは Sendo の
   * オリジンが分からないので、設定で受け取る
   */
  issuer: string;
  /** 許可の画面（/oauth/authorize）を置く sendo-reader のオリジン */
  readerOrigin: string;
}

/** Web Push の設定（docs/decisions/web-push.md の 2、3）。両方そろったときだけ使える */
export interface PushConfig {
  /** VAPID の JWT の sub（mailto: か https: の URL） */
  subject: string;
  /** 通知から記事を開く sendo-reader のオリジン */
  readerOrigin: string;
}

/** ブラウザのログインの設定（docs/decisions/accounts.md） */
export interface AuthConfig {
  /** ユーザーになれるメールアドレス（小文字） */
  allowedEmails: ReadonlySet<string>;
  /** Google のクライアント。なければ Google ではログインできない */
  google: OAuthClient | undefined;
  /** OAuth の認可サーバー。なければ OAuth は使えない（/mcp は MCP 用のトークンだけで使う） */
  oauth: OAuthServerConfig | undefined;
}

/** フィードの取得の設定（docs/decisions/jobs.md の 6） */
export interface FetchConfig {
  /**
   * 取得の間隔の下限（ミリ秒）。フィードごとの間隔は、記事の出るペースから、これより短くならない
   * ように決める（docs/decisions/jobs.md の 7）
   */
  intervalMs: number;
}

/** 古い記事の片付けの設定（docs/decisions/retention.md の 1） */
export interface RetentionConfig {
  /** 記事と本文を保管する容量の上限（バイト。行と索引の分は見積もり） */
  maxBytes: number;
}

/**
 * オブジェクトの置き場（docs/decisions/content.md の 3）。記事の本文を置く。置く、読む、消すだけを
 * 使う。実装は、データのボリュームの上のファイル（platform/node/file-store.ts）
 */
export interface ObjectStore {
  /** 置く。同じ名前があれば上書きする */
  put(key: string, text: string): Promise<void>;
  /** 読む。なければ null */
  get(key: string): Promise<string | null>;
  /** 消す。ない名前は、そのまま通す。1 回に 1,000 個まで */
  delete(keys: readonly string[]): Promise<void>;
}

/** 記事のページから抜いた本文（サニタイズしていない HTML） */
export interface ExtractedPage {
  title: string;
  html: string;
  /** 本文の文字数（タグを除いたもの） */
  textLength: number;
}

/** 本文中の画像と、その画像だけを含むリンク */
export interface PageImageLink {
  thumbnail: string;
  target: string;
}

/** 画像の解析は Rust、取得は fetcher が担当する */
export interface PageImageProcessor {
  links(html: string, url: string): Promise<PageImageLink[]>;
  candidates(input: {
    bytes: Uint8Array;
    contentType: string | null;
    url: string;
  }): Promise<string[]>;
  compare(
    thumbnail: Uint8Array,
    candidate: Uint8Array | null,
  ): Promise<{ eligible: boolean; matches: boolean }>;
  replace(html: string, link: PageImageLink, replacement: string): Promise<string>;
  /** 導入の画像（3 枚まで）と、そのあとの画像（12 枚まで）の URL（docs/decisions/content.md の 21） */
  leadImages(html: string, url: string): Promise<{ lead: string[]; later: string[] }>;
  /** 縁の帯を除いてから、同じ写真かを見る。大きさは問わない */
  samePicture(image: Uint8Array, other: Uint8Array): Promise<boolean>;
  /** URL（leadImages が返したもの）が同じ最初の画像を落とす。空になったリンクも落とす */
  removeImage(html: string, src: string, url: string): Promise<string>;
}

/**
 * 記事のページのバイト列から本文を抜く（docs/decisions/content.md の 11、12）。Rust の処理を
 * napi-rs で読み込む。外への取得はしない。本文が見つからなければ null
 */
export interface PageContentExtractor {
  images?: PageImageProcessor;
  extract(input: {
    bytes: Uint8Array;
    contentType: string | null;
    /** ページの URL。本文の中のリンクと画像の URL の基準にする */
    url: string;
  }): Promise<ExtractedPage | null>;
}

export interface LanguageDetectionResult {
  language: string;
  status: "detected" | "insufficient" | "uncertain";
  score: number;
  margin: number;
  inputHash: string;
}

/** LLM や外部への通信を使わず、本文の自然文を判定する */
export interface LanguageDetector {
  detector: string;
  pipelineRevision: number;
  detect(html: string): Promise<LanguageDetectionResult>;
}

/** 記事の候補の語（docs/decisions/article-analysis.md の 8〜11） */
export interface AnalysisCandidate {
  /** 表記（NFKC のあと） */
  surface: string;
  /** まとめの鍵 */
  key: string;
  /** 出どころ。フィードのカテゴリか、記事の文字 */
  source: "category" | "text";
}

export interface ArticleAnalysisInput {
  title: string;
  /** 解析の入力に使う要約。同じフィードで同じ要約なら空にする（記事の解析の 8） */
  summary: string;
  /** 抜いた本文（なければフィードの本文）の HTML */
  html: string;
  categories: readonly string[];
  /** 候補の語を作るか */
  candidates: boolean;
  /** 埋め込みを作るか */
  embedding: boolean;
}

export interface ArticleAnalysisResult {
  /** 候補の語を求めたときだけ */
  candidates?: AnalysisCandidate[];
  /** 埋め込みを求めたときだけ。入力が空なら null（「入力が空」） */
  embedding?: Float32Array | null;
}

/** 記事から候補の語と埋め込みを作る（Rust。docs/decisions/article-analysis.md） */
export interface ArticleAnalyzer {
  candidateRevision: number;
  embeddingRevision: number;
  /** 埋め込みの次元 */
  dimension: number;
  analyze(input: ArticleAnalysisInput): Promise<ArticleAnalysisResult>;
  /** 文の埋め込み（タグの名前と説明など）。空なら null */
  embedText(text: string): Promise<Float32Array | null>;
}

/** SQLite の索引を作るための、共有記事の現在の入力。 */
export type SearchInput = {
  articleId: string;
  title: string | null;
  summary: string | null;
  contentKey: string | null;
  pageHtml: string | null;
  revision: string;
};

export interface ArticleSearch {
  pending(limit: number): Promise<SearchInput[]>;
  retry(input: Pick<SearchInput, "articleId" | "revision">): Promise<void>;
  store(input: {
    articleId: string;
    revision: string;
    content: string;
    bytes: number;
  }): Promise<boolean>;
  find(input: ArticleListInput & { keyword: string }): Promise<{
    items: (InboxArticle & { snippet: string })[];
    next: ArticleCursor | null;
  }>;
}

/** 人ごとの同期の対象が変わったことを、利用者の接続に知らせる（docs/decisions/sync.md の 9）。 */
export interface SyncUpdates {
  connect(context: Context, session: SessionIdentity): Promise<Response>;
  notify: SyncNotifier;
}

/** 訳す文。断片ごとに ID を付ける（docs/decisions/translation.md の 10） */
export interface TranslationSegment {
  id: string;
  text: string;
}

/**
 * 訳せた呼び出しのトークン数（応答の usage。docs/decisions/translation.md の 18）。代わりのモデルに
 * 替わったときは、応答が返す合計
 */
export interface TranslationUsage {
  /** 入力のトークン数（キャッシュに書いた・読んだ分も足す） */
  inputTokens: number;
  outputTokens: number;
}

export type TranslationResult =
  /**
   * 訳せた。返ってこなかった断片は入らない。model は応答が返したモデル（代わりのモデルに替わったら、
   * 代わりのモデル）
   */
  | {
      status: "translated";
      segments: TranslationSegment[];
      model: string;
      usage: TranslationUsage;
    }
  /**
   * 拒否された（代わりのモデルでも訳せなかった）。category は拒否の応答の stop_details.category
   * （cyber など。なければ null。docs/decisions/translation.md の 17）
   */
  | { status: "refused"; category: string | null }
  /** 上限で切れた、または形の読めない応答 */
  | { status: "invalid" };

/**
 * 呼び出しの失敗。やり直しても通らないもの（要求の形の誤り）は retryable が false。responded は、
 * Claude API が受け付けずに断ったと分かる応答（400、401、403、404、413、429、529）のとき true。
 * 届かない・時間切れ・ほかの 5xx などでは false（受け付けられたかどうか分からない）
 */
export class TranslatorError extends Error {
  readonly responded: boolean;
  constructor(
    message: string,
    readonly retryable: boolean,
    options?: { cause?: unknown; responded?: boolean },
  ) {
    super(message, options);
    this.name = "TranslatorError";
    this.responded = options?.responded ?? false;
  }
}

/** 翻訳の段階（docs/decisions/translation.md の 9）。通常 ／ 長文 ／ 品質優先 */
export type TranslationTier = "normal" | "long" | "quality";

/** バッチで送る記事の段階（docs/decisions/translation.md の 9。送る本文が閾値以上なら長文） */
export type BatchTier = Exclude<TranslationTier, "quality">;

/** その場で訳す段階（その場の翻訳は通常、訳し直しは品質優先。docs/decisions/translation.md の 9） */
export type OnDemandTier = Exclude<TranslationTier, "long">;

/**
 * 段階で送るときの条件（思考量とプロンプトの版）。訳文の行に残す（docs/decisions/translation.md の 9、
 * 18）
 */
export interface TranslationConditions {
  effort: TranslationEffort;
  /** プロンプトの版（システムプロンプトと送る形を変えるたびに上げる、コードに持つ番号） */
  promptVersion: number;
}

/**
 * バッチで訳してもらう 1 件（docs/decisions/translation.md の 4）。id は記事の ID。tier の段階の
 * モデルと思考量で送る
 */
export interface BatchTranslationRequest {
  id: string;
  segments: readonly TranslationSegment[];
  tier: BatchTier;
}

/**
 * バッチの 1 件の結果。訳せた ／ 拒否 ／ 読めない応答（TranslationResult。訳せたときの断片は、送った
 * ものに絞っていない）か、errored ／ expired ／ canceled
 */
export type BatchTranslationResult = { id: string } & (
  | TranslationResult
  /**
   * 要求が通らなかった。errorType は Claude API の誤りの種類（invalid_request_error など）。
   * countedForModel は、要求の形の誤りをモデルを外す判断に数えた（回数には数えない。決定の 8、9）
   */
  | { status: "errored"; errorType: string | null; countedForModel: boolean }
  | { status: "expired" }
  | { status: "canceled" }
);

export type BatchTranslationStatus =
  /** まだ終わっていない */
  | { status: "in_progress" }
  /** 終わった。結果は記事ごと（返らなかった記事は入らない） */
  | { status: "ended"; results: BatchTranslationResult[] }
  /** もう見られない（404） */
  | { status: "gone" };

/** 記事を日本語に訳す（Claude API。docs/decisions/translation.md） */
export interface Translator {
  /**
   * バッチで送る記事の段階。送る本文（写す本文と、タイトル・要約は数えない。本文を送らなければ 0）の
   * Unicode の文字数が、設定の閾値以上なら長文（docs/decisions/translation.md の 9）
   */
  batchTier(sentBodyChars: number): BatchTier;
  /**
   * その段階で送るときの思考量とプロンプトの版（docs/decisions/translation.md の 18）。バッチは送る印を
   * 付けるときに、その場の翻訳は結果を書くときに、行に書く
   */
  conditions(tier: TranslationTier): TranslationConditions;
  /**
   * その場で訳す（通常の Messages API）。その場の翻訳は通常の段階、訳し直しは品質優先の段階で訳す
   * （docs/decisions/translation.md の 6、9）。呼び出しが失敗したら TranslatorError を投げる
   */
  translate(
    segments: readonly TranslationSegment[],
    options: { tier: OnDemandTier },
  ): Promise<TranslationResult>;
  /** バッチで使えなかった本文断片だけを、指定された条件で 1 回補う（決定の 4） */
  repairBatchBody(
    segments: readonly TranslationSegment[],
    options: { model: string; effort: TranslationEffort; timeoutMs: number },
  ): Promise<{
    segments: TranslationSegment[];
    usage: { inputTokens: number | null; outputTokens: number | null } | null;
  }>;
  /**
   * バッチを作って送る（Message Batches API）。バッチの ID を返す。失敗したら TranslatorError を投げる
   * （作れたかどうか分からないこともある）
   */
  createBatch(requests: readonly BatchTranslationRequest[]): Promise<string>;
  /** バッチを見にいき、終わっていれば結果を読む。見にいけなければ TranslatorError を投げる */
  checkBatch(batchId: string): Promise<BatchTranslationStatus>;
}

/**
 * 重い読み取り（docs/decisions/container.md の 5）。1 回で数百 ms を超える集計を、主のスレッドとは別の
 * スレッドの、書き込めない接続で流す。重い読み取りは 1 つずつ流す
 */
export interface HeavyRead {
  /** 文を流して行を返す。書き込む文は失敗する */
  all<T>(query: SQL): Promise<T[]>;
}

/** アプリが実行環境から受け取るもの */
export interface Platform {
  db: Database;
  /** 重い読み取りを流す（主のスレッドを止めない） */
  heavyRead: HeavyRead;
  articleSearch: ArticleSearch;
  jobs: JobQueue;
  /** 記事の本文の置き場 */
  content: ObjectStore;
  /** 外部の URL を取得する。SSRF の確認は呼ぶ側（fetcher/）で行う */
  fetch: typeof fetch;
  now: () => Date;
  auth: AuthConfig;
  discord?: DiscordConfig;
  /** Web Push。設定がそろっていなければない（docs/decisions/web-push.md の 3） */
  push?: PushConfig;
  fetchConfig: FetchConfig;
  retentionConfig: RetentionConfig;
  /** 記事のページから本文を抜く（Rust） */
  pageContent: PageContentExtractor;
  /** 記事の主言語を調べる（Rust） */
  languageDetection: LanguageDetector;
  /** 記事から候補の語と埋め込みを作る（Rust） */
  articleAnalysis: ArticleAnalyzer;
  syncUpdates: SyncUpdates;
  /** 記事を訳す。API キーがなければない（docs/decisions/translation.md の 15） */
  translator?: Translator;
}

/** 取得の間隔の既定（分） */
export const DEFAULT_FETCH_INTERVAL_MINUTES = 30;

/**
 * 取得の間隔の下限（分）。相手への取得の頻度を決めるもので、定期実行の間隔（SCHEDULE_INTERVAL_MINUTES）
 * とは別に決める（docs/decisions/jobs.md の 6）
 */
export const MIN_FETCH_INTERVAL_MINUTES = 10;

/**
 * 定期実行の間隔（分。docs/decisions/jobs.md の 12）。時計のこの分の区切りごとに、取得の時期が来た
 * フィードを積む（platform/node/scheduler.ts）
 */
export const SCHEDULE_INTERVAL_MINUTES = 5;

/** 保存容量の既定（MiB）。10 GiB */
export const DEFAULT_STORAGE_LIMIT_MIB = 10 * 1024;
export const MIN_STORAGE_LIMIT_MIB = 16;

/** 下限以上の整数の設定を読む。空なら undefined（既定を使う）。下限以上の整数でなければ例外 */
function parseIntegerSetting(
  value: string | undefined,
  min: number,
  name: string,
): number | undefined {
  const text = value?.trim() ?? "";
  if (text === "") return undefined;
  const number = Number(text);
  if (!/^\d+$/.test(text) || number < min) {
    throw new RangeError(`${name} must be an integer of at least ${min}: ${text}`);
  }
  return number;
}

/**
 * 取得の間隔（分）の設定を読む。空なら undefined（既定を使う）。下限以上の整数でなければ例外。
 * 設定は実行環境ごとに渡し方が違うので、読むのは緩衝層の実装で行い、形だけここで決める。
 */
export function parseFetchIntervalMinutes(value: string | undefined): number | undefined {
  return parseIntegerSetting(value, MIN_FETCH_INTERVAL_MINUTES, "fetch interval (minutes)");
}

/** 保存容量（MiB）。誤設定で意図せず記事を消さないよう、整数の範囲も確かめる */
export function parseStorageLimitMiB(value: string | undefined): number | undefined {
  const mib = parseIntegerSetting(value, MIN_STORAGE_LIMIT_MIB, "storage limit (MiB)");
  if (mib !== undefined && !Number.isSafeInteger(mib * 1024 * 1024)) {
    throw new RangeError("storage limit is too large");
  }
  return mib;
}

/**
 * 許可するメールの並び（カンマか空白で区切る）を読む。小文字にそろえ、空のものは除く。
 * 設定は実行環境ごとに渡し方が違うので、読むのは緩衝層の実装で行い、形だけここで決める。
 */
export function parseEmailList(value: string | undefined): ReadonlySet<string> {
  return new Set(
    (value ?? "")
      .split(/[\s,]+/)
      .map((email) => email.trim().toLowerCase())
      .filter((email) => email !== ""),
  );
}

/** 手元で動かすときに、http でもよいホスト */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * 設定に書いたオリジン（https://sendo.example.com）を読む。末尾の / は除く。
 * https（手元で動かすなら http://localhost なども）で、パス・クエリ・フラグメント・
 * ユーザー名のないものだけを受ける。空なら undefined、形が正しくなければ例外
 */
export function parseOrigin(value: string | undefined): string | undefined {
  const text = value?.trim() ?? "";
  if (text === "") return undefined;
  const url = new URL(text);
  const secure =
    url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname));
  if (
    !secure ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    text.endsWith("?") ||
    text.endsWith("#")
  ) {
    throw new Error(`not an https origin: ${text}`);
  }
  return url.origin;
}
