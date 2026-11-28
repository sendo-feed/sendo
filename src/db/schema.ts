import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  blob,
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import type { FeedRelocationCandidate } from "../fetcher/discover";
import type { FetchFeedErrorCode } from "../fetcher/fetch-feed";

/**
 * ユーザー。パスワードは持たない（docs/decisions/accounts.md）。
 * 外部の提供元でのログインは identities に置き、1 人が複数の提供元を持てる。
 */
export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  /** 小文字にそろえる。許可の判定、提供元のログインとの結び付け、表示に使う */
  email: text("email").notNull().unique(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

/**
 * 外部の提供元（Google、GitHub など）でのログイン。issuer と subject で見分ける。
 *
 * 初めてその提供元でログインしたとき、確認済みのメールが一致するユーザーに結び付ける。
 * 結び付けたあとは issuer と subject で見分けるので、提供元の側でメールが変わっても
 * 同じユーザーのまま。
 */
export const identities = sqliteTable(
  "identities",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    issuer: text("issuer").notNull(),
    subject: text("subject").notNull(),
    /** 最後にログインしたときに、提供元が確認済みとしたメール */
    email: text("email").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    uniqueIndex("identities_issuer_subject_idx").on(t.issuer, t.subject),
    index("identities_user_id_idx").on(t.userId),
  ],
);

/**
 * REST API と MCP のアクセストークン。中身は持たず、SHA-256 のハッシュだけを置く。
 */
export const accessTokens = sqliteTable(
  "access_tokens",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** 用途の名前（「CLI」「Claude Code」など） */
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    /** 最後に使った時刻。書き込みを減らすため、1 時間に 1 回だけ更新する */
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
    /**
     * 用途（docs/decisions/mcp.md の 2）。reader は REST API 用、
     * mcp は /mcp 用。用途の違う入口では使えない
     */
    purpose: text("purpose", { enum: ["reader", "mcp"] })
      .notNull()
      .default("reader"),
    /** 範囲（空白で区切る）。mcp なら "read" か "read write"。reader は持たない（空） */
    scopes: text("scopes").notNull().default(""),
  },
  (t) => [index("access_tokens_user_id_idx").on(t.userId)],
);

/**
 * ブラウザのログインのセッション（docs/decisions/accounts.md の 6）。クッキーに入れる中身は持たず、
 * SHA-256 のハッシュだけを置く。行を消せば、そのセッションは使えなくなる（ログアウト、取り消し）。
 */
export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    /** 最後に使った時刻。書き込みを減らすため、1 時間に 1 回だけ更新する */
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }).notNull(),
    /** この時刻を過ぎたら使えない。使うたびに（last_used_at と一緒に）先へ延ばす */
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("sessions_user_id_idx").on(t.userId)],
);

/**
 * 動的登録（RFC 7591）で登録した OAuth のクライアント（docs/decisions/mcp.md の 5）。
 * 公開クライアント（秘密なし）だけ。Client ID Metadata Document のクライアント（ID が https の URL）は、
 * 情報をその URL から取るので、ここには置かない
 */
export const oauthClients = sqliteTable("oauth_clients", {
  /** client_id。Sendo が乱数で振る */
  id: text("id").primaryKey(),
  /** client_name。クライアントが名乗ったもので、確かめてはいない */
  name: text("name"),
  /** リダイレクト先。認可のリクエストでは、このどれかと完全に一致するものだけを受ける */
  redirectUris: text("redirect_uris", { mode: "json" }).$type<string[]>().notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  /**
   * 初めて許可された時刻。一度も許可されないまま 1 日たったクライアントは消す（誰でも登録できるので）。
   * 一度許可されたものは、許可を取り消したあとも残す（クライアントは同じ client_id でつなぎ直す）
   */
  authorizedAt: integer("authorized_at", { mode: "timestamp_ms" }),
});

/**
 * 利用者が OAuth のクライアントに出した許可（docs/decisions/mcp.md の 7）。許可の画面で「許可」を
 * 選ぶたびに 1 つ作る。認可コードとトークンはこれに付き、消すとまとめて使えなくなる。
 *
 * 使えなくなった許可（期限の切れていないリフレッシュトークンも、使っていない認可コードもない）は、
 * 一覧に出さず、同じ人が次に許可するときに消す（db/oauth.ts）
 */
export const oauthGrants = sqliteTable(
  "oauth_grants",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** 動的登録で振った ID か、Client ID Metadata Document の URL */
    clientId: text("client_id").notNull(),
    /** 許可したときのクライアントの名前（一覧に出す） */
    clientName: text("client_name"),
    /** 範囲（"read" か "read write"） */
    scopes: text("scopes").notNull(),
    /** トークンの宛先（RFC 8707）。https://<sendo>/mcp */
    resource: text("resource").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("oauth_grants_user_id_idx").on(t.userId)],
);

/** 認可コード。1 回だけ使える。使ったコードがもう一度来たら、許可ごと取り消す（OAuth 2.1 の 4.1.3） */
export const oauthCodes = sqliteTable(
  "oauth_codes",
  {
    /** コードのハッシュ（SHA-256 の 16 進）。中身は DB に置かない */
    codeHash: text("code_hash").primaryKey(),
    grantId: text("grant_id")
      .notNull()
      .references(() => oauthGrants.id, { onDelete: "cascade" }),
    /** 認可のリクエストの redirect_uri。トークンのリクエストでも同じものを求める */
    redirectUri: text("redirect_uri").notNull(),
    /** PKCE の code_challenge（S256） */
    codeChallenge: text("code_challenge").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    usedAt: integer("used_at", { mode: "timestamp_ms" }),
  },
  (t) => [index("oauth_codes_grant_id_idx").on(t.grantId)],
);

/**
 * OAuth で出したアクセストークン（1 時間）とリフレッシュトークン（30 日）。DB にはハッシュだけを置く。
 * リフレッシュトークンは使うたびに作り直し、作り直したものがもう一度来たら、許可ごと取り消す
 */
export const oauthTokens = sqliteTable(
  "oauth_tokens",
  {
    id: text("id").primaryKey(),
    grantId: text("grant_id")
      .notNull()
      .references(() => oauthGrants.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["access", "refresh"] }).notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    /** 範囲（"read" か "read write"） */
    scopes: text("scopes").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    /** リフレッシュトークンを使って、新しいものに作り直した時刻 */
    rotatedAt: integer("rotated_at", { mode: "timestamp_ms" }),
  },
  (t) => [index("oauth_tokens_grant_id_idx").on(t.grantId)],
);

/*
 * ここから下は、共有のデータ（feeds、articles）と、人ごとのデータ（folders、subscriptions、
 * user_articles）に分かれる（docs/decisions/accounts.md）。
 *
 * 人ごとのデータは、差分同期のために変更番号（seq）と消した印（deleted_at）を持つ
 * （docs/decisions/sync.md）。番号の振り方は db/seq.ts。
 */

/** 変更番号の列。作ったときと変えたときに、db/seq.ts の nextSeq で振る */
const seq = () => integer("seq").notNull();

/** ユーザーのフォルダ（Feedly のカテゴリ、OPML の入れ子の outline） */
export const folders = sqliteTable(
  "folders",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    /** 消した時刻。消した印として行は残し、同期でクライアントに伝える */
    deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
    seq: seq(),
  },
  (t) => [
    // 消した印の付いたフォルダと同じ名前は、もう一度作れる
    uniqueIndex("folders_user_id_name_idx").on(t.userId, t.name).where(sql`${t.deletedAt} is null`),
    index("folders_user_id_seq_idx").on(t.userId, t.seq),
    // 次の変更番号を振るときの「表の最大」を、全部読まずに 1 行で取る（db/seq.ts）
    index("folders_seq_idx").on(t.seq),
  ],
);

/** ユーザーが、購読の表示範囲を分けるためのワークスペース。 */
export const workspaces = sqliteTable(
  "workspaces",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
    seq: seq(),
  },
  (t) => [
    uniqueIndex("workspaces_user_id_name_idx")
      .on(t.userId, t.name)
      .where(sql`${t.deletedAt} is null`),
    uniqueIndex("workspaces_user_id_default_idx")
      .on(t.userId)
      .where(sql`${t.isDefault} = 1 and ${t.deletedAt} is null`),
    index("workspaces_user_id_seq_idx").on(t.userId, t.seq),
    index("workspaces_seq_idx").on(t.seq),
  ],
);

export type FeedErrorCode = FetchFeedErrorCode | "invalid_feed";

/** Discord OAuth で確認した、Sendo のユーザーと Discord のアカウントの結び付き */
export const discordConnections = sqliteTable("discord_connections", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: "cascade" }),
  discordUserId: text("discord_user_id").notNull(),
});

/** フィード。公開フィードは共有し、Discord のフィードは接続ごとに持つ */
export const feeds = sqliteTable(
  "feeds",
  {
    id: text("id").primaryKey(),
    /** 取得に使う URL。正規化してから保存する */
    url: text("url").notNull(),
    discordConnectionId: text("discord_connection_id").references(() => discordConnections.id),
    /** Discord の新着取得の位置。解除後も、公開フィードと区別するため null には戻さない */
    discordCursor: text("discord_cursor"),
    title: text("title"),
    siteUrl: text("site_url"),
    /** 条件付き GET に使う。前回の応答の ETag ／ Last-Modified */
    etag: text("etag"),
    lastModified: text("last_modified"),
    /** 取得を試した時刻 */
    lastFetchedAt: integer("last_fetched_at", { mode: "timestamp_ms" }),
    /** 取得に成功した最後の試行の開始時刻（304 を含む） */
    lastSuccessfulFetchAt: integer("last_successful_fetch_at", { mode: "timestamp_ms" }),
    /** この時刻を過ぎたら、定期実行で取得のキューに積む（購読している人がいるときだけ） */
    nextFetchAt: integer("next_fetch_at", { mode: "timestamp_ms" }).notNull(),
    /** 通常の取得予定と別に覚える Discord REST の再開期限（仕事の流し方の 8） */
    discordRetryAt: integer("discord_retry_at", { mode: "timestamp_ms" }),
    /**
     * 取得の間隔（ミリ秒。docs/decisions/jobs.md の 7、11）。取得に成功するたびに、記事の出るペースか
     * 時刻の癖（枠）から決め直した、次の取得までの長さ。null なら、まだ決めていない（設定の間隔を使う）。書くのは取得の記録の UPDATE の中だけ
     * にし、索引は付けない（取得のたびに索引を書き換えないため）
     */
    fetchIntervalMs: integer("fetch_interval_ms"),
    /** 続けて失敗した回数（429 を除く）。成功したら 0 に戻す */
    errorCount: integer("error_count").notNull().default(0),
    lastError: text("last_error"),
    lastErrorCode: text("last_error_code").$type<FeedErrorCode>(),
    /** 今の失敗が続き始めた時刻。導入前の失敗は開始時刻が分からない */
    failureStartedAt: integer("failure_started_at", { mode: "timestamp_ms" }),
    /** 取得の失敗が長期化したか、HTTP 410 が返ったか（docs/decisions/jobs.md の 9） */
    fetchStalled: integer("fetch_stalled", { mode: "boolean" }).notNull().default(false),
    /** 失敗した応答から確認できた候補（docs/decisions/feed-relocation.md） */
    relocationCandidate: text("relocation_candidate", {
      mode: "json",
    }).$type<FeedRelocationCandidate>(),
    /**
     * どこまでの記事を、購読している人の受信箱に配ったか（記事の created_at）。
     * 配るのが途中で落ちても、次の取得でここから配り直せる
     */
    deliveredUntil: integer("delivered_until", { mode: "timestamp_ms" }),
    /**
     * アイコンの URL（docs/decisions/images.md の 8）。実際に取得して、画像と確かめられたものだけを置く。
     * 変わると、トリガーが購読の変更番号を進める（migrations/0016_feed_icon_trigger.sql）。
     * API では、中継を通る URL にして返す
     */
    iconUrl: text("icon_url"),
    /** アイコンを最後に探した時刻。null なら、まだ探していない */
    iconCheckedAt: integer("icon_checked_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    index("feeds_next_fetch_at_idx").on(t.nextFetchAt),
    uniqueIndex("feeds_public_url_idx").on(t.url).where(sql`${t.discordCursor} is null`),
    uniqueIndex("feeds_discord_connection_url_idx").on(t.discordConnectionId, t.url),
    index("feeds_discord_url_idx").on(t.url, t.id).where(sql`${t.discordConnectionId} is not null`),
  ],
);

/** ユーザーの購読。フィードは共有で、どのフォルダに入れるかは人ごと */
export const subscriptions = sqliteTable(
  "subscriptions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    feedId: text("feed_id")
      .notNull()
      .references(() => feeds.id, { onDelete: "cascade" }),
    /** 入っているフォルダ。フォルダを消すときは、先にこの列を null に戻す */
    folderId: text("folder_id").references(() => folders.id),
    workspaceId: text("workspace_id").references(() => workspaces.id),
    displayName: text("display_name"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    /**
     * 購読を始めたときに、すでに取り込んであった最近の記事を受信箱に入れ終えた時刻。
     * null なら、まだ入れていない（入れる途中で落ちても、やり直せば入る）
     */
    backfilledAt: integer("backfilled_at", { mode: "timestamp_ms" }),
    /** 購読をやめた時刻。消した印として行は残し、同期でクライアントに伝える */
    deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
    seq: seq(),
  },
  (t) => [
    // 購読をやめたフィードは、もう一度購読できる
    uniqueIndex("subscriptions_user_id_feed_id_idx")
      .on(t.userId, t.feedId)
      .where(sql`${t.deletedAt} is null`),
    index("subscriptions_feed_id_idx").on(t.feedId),
    index("subscriptions_active_workspace_idx")
      .on(t.userId, t.workspaceId)
      .where(sql`${t.deletedAt} is null`),
    index("subscriptions_user_id_seq_idx").on(t.userId, t.seq),
    index("subscriptions_seq_idx").on(t.seq),
  ],
);

/** フィードから取り込んだ記事。全員で共有し、取り込んだあとは変えない */
export const articles = sqliteTable(
  "articles",
  {
    id: text("id").primaryKey(),
    feedId: text("feed_id")
      .notNull()
      .references(() => feeds.id, { onDelete: "cascade" }),
    /** フィードの中で記事を見分けるキー。guid ／ id、なければリンク、それもなければ内容のハッシュ */
    guid: text("guid").notNull(),
    /** http ／ https の URL だけを保存する */
    url: text("url"),
    /** タイトルと要約はタグを除いたプレーンテキスト。表示する側でエスケープする */
    title: text("title"),
    summary: text("summary"),
    author: text("author"),
    /**
     * サムネイルのもとの URL（docs/decisions/images.md の 7）。http ／ https だけ。フィードの中から採り、
     * 取り込んだあとは変えない。API では、中継を通る URL にして返す
     */
    thumbnailUrl: text("thumbnail_url"),
    /** フィードに日付がなければ、取り込んだ時刻を入れる */
    publishedAt: integer("published_at", { mode: "timestamp_ms" }).notNull(),
    /**
     * 公開日時の時刻（時と分）まで分かるか（docs/decisions/jobs.md の 11）。フィードに時刻まで
     * 書いてあった記事と、Discord の投稿だけが true。日付だけの記事と、日付がなく取り込んだ時刻を
     * 入れた記事は false。この列を足す前に取り込んだ記事も false（あとから推し量って埋めない）。
     * 取得の時刻を決めるときに、記事の出る時刻の材料にするかを分ける
     */
    publishedTimeKnown: integer("published_time_known", { mode: "boolean" })
      .notNull()
      .default(false),
    /** 取り込んだ時刻（DB の時計）。受信箱に配る範囲を決めるのに使う */
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    /**
     * フィードに入っていた本文の、置き場での名前（docs/decisions/content.md の 3）。本文がなければ
     * null。取り込むときに決まり、あとから変えない。名前は置くたびに乱数で決め、二度使わない。
     * API には、名前ではなく、本文があるかどうかだけを出す
     */
    contentKey: text("content_key"),
    /** 直近の完全なフィードに載っているか。容量による削除で入り直すことを防ぐ */
    inCurrentFeed: integer("in_current_feed", { mode: "boolean" }).notNull().default(true),
    /** 配布を終えるまで確保する受信箱の容量。本文の有無によらず取り込みと同じ文で確保する */
    reservedInboxBytes: integer("reserved_inbox_bytes").notNull().default(0),
  },
  (t) => [
    // 本文のある記事だけを索引に入れる（片付けが、名前から記事の行があるかを引く）
    uniqueIndex("articles_content_key_idx").on(t.contentKey).where(sql`content_key is not null`),
    uniqueIndex("articles_feed_id_guid_idx").on(t.feedId, t.guid),
    index("articles_feed_id_created_at_idx").on(t.feedId, t.createdAt),
    index("articles_feed_id_published_at_idx").on(t.feedId, t.publishedAt),
    index("articles_created_at_id_idx").on(t.createdAt, t.id),
    index("articles_feed_id_current_idx").on(t.feedId, t.inCurrentFeed),
    index("articles_pending_delivery_idx")
      .on(t.feedId, t.createdAt)
      .where(sql`reserved_inbox_bytes > 0`),
  ],
);

/**
 * 記事のページから抜いた本文（docs/decisions/content.md の 10〜15）。記事ごとに 1 行。全員で
 * 共有する。記事の行は取り込んだあとは変えないので、あとから付く結果は、この表に持つ。
 *
 * - 抜けたとき：status は extracted、html にサニタイズした本文を入れる。あとから変えない
 * - 抜けなかったとき：status は failed。開いたときの抜き取りは、1 日たてば取りにいき直す
 * - 本文は置き場（ファイル）ではなく、この行に入れる（決定の 13）。記事の行が消えると、連鎖で消える
 */
export const pageContents = sqliteTable("page_contents", {
  articleId: text("article_id")
    .primaryKey()
    .references(() => articles.id, { onDelete: "cascade" }),
  status: text("status", { enum: ["extracted", "failed"] }).notNull(),
  /** サニタイズした本文の HTML。抜けたときだけ */
  html: text("html"),
  /** 最後に取りにいった時刻 */
  attemptedAt: integer("attempted_at", { mode: "timestamp_ms" }).notNull(),
});

/** 主言語の判定は共有の派生データ。元の記事・本文や人ごとの変更番号は変えない */
export const articleLanguages = sqliteTable(
  "article_languages",
  {
    articleId: text("article_id")
      .notNull()
      .references(() => articles.id, { onDelete: "cascade" }),
    source: text("source", { enum: ["feed", "page", "metadata"] }).notNull(),
    language: text("language").notNull(),
    status: text("status", {
      enum: ["detected", "provisional", "insufficient", "uncertain"],
    }).notNull(),
    score: real("score").notNull(),
    margin: real("margin").notNull(),
    inputHash: text("input_hash").notNull(),
    detector: text("detector").notNull(),
    pipelineRevision: integer("pipeline_revision").notNull(),
  },
  (t) => [primaryKey({ columns: [t.articleId, t.source] })],
);

export type ArticleLanguage = typeof articleLanguages.$inferSelect;

/**
 * フィードのカテゴリ（docs/decisions/article-analysis.md の 8）。取得の仕事が、記事を入れたあと、ページを
 * 抜く仕事と解析の仕事を積む前に、記事ごとに 10 個まで入れる。記事の行は変えない。position はフィードに
 * 出てきた順（0 から）。記事の行が消えると、連鎖で消える
 */
export const articleCategories = sqliteTable(
  "article_categories",
  {
    articleId: text("article_id")
      .notNull()
      .references(() => articles.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    name: text("name").notNull(),
  },
  (t) => [primaryKey({ columns: [t.articleId, t.position] })],
);

/** 解析の状態。済み ／ 入力が空 ／ 失敗（docs/decisions/article-analysis.md の 5） */
export const ANALYSIS_STATUSES = ["done", "empty", "failed"] as const;

/**
 * 記事の解析（docs/decisions/article-analysis.md の 5）。記事ごとに 1 行。全員で共有する派生データで、
 * API と同期には出さない。記事の行が消えると、連鎖で消える。
 *
 * - 候補と埋め込みで版・状態を分け、それぞれの版を別々に比べて、古いほうの列だけを書く。同じ版は
 *   上書きしない
 * - candidate_generation は、この解析で入れた候補の行の世代。候補を読む側は、この世代の候補の行だけを使う
 * - summary_hash は、要約を NFKC にして空白をそろえた文の SHA-256。要約が空なら null（8）
 * - embedding は正規化した float32 のリトルエンディアン（7）
 */
export const articleAnalyses = sqliteTable(
  "article_analyses",
  {
    articleId: text("article_id")
      .primaryKey()
      .references(() => articles.id, { onDelete: "cascade" }),
    feedId: text("feed_id").notNull(),
    summaryHash: text("summary_hash"),
    candidateRevision: integer("candidate_revision"),
    candidateStatus: text("candidate_status", { enum: ANALYSIS_STATUSES }),
    candidateGeneration: text("candidate_generation"),
    embeddingRevision: integer("embedding_revision"),
    embeddingStatus: text("embedding_status", { enum: ANALYSIS_STATUSES }),
    embedding: blob("embedding", { mode: "buffer" }).$type<Uint8Array>(),
    /** 最後に書いた時刻。書く文の中の DB の時計で決める */
    analyzedAt: integer("analyzed_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    // 同じフィードのほかの記事に同じ要約があるかを引く（8）
    index("article_analyses_feed_id_summary_hash_idx")
      .on(t.feedId, t.summaryHash)
      .where(sql`${t.summaryHash} is not null`),
  ],
);

export type ArticleAnalysis = typeof articleAnalyses.$inferSelect;

/**
 * 記事の候補の語（docs/decisions/article-analysis.md の 5、10）。解析ごとに新しい世代の番号で、1 つの文で
 * まとめて入れる。解析の行の世代と合わない行は、どこからも読まれず、作ってから 1 日たつと 1 日 1 回の
 * 片付けが消す
 */
export const articleCandidates = sqliteTable(
  "article_candidates",
  {
    articleId: text("article_id")
      .notNull()
      .references(() => articles.id, { onDelete: "cascade" }),
    generation: text("generation").notNull(),
    /** まとめの鍵（11） */
    key: text("key").notNull(),
    /** 表記（NFKC のあと） */
    surface: text("surface").notNull(),
    source: text("source", { enum: ["category", "text"] }).notNull(),
    /** 作った時刻。書く文の中の DB の時計で決める */
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.articleId, t.generation, t.key] }),
    // 世代の合わない行の片付けで、古い行から引く
    index("article_candidates_created_at_idx").on(t.createdAt),
  ],
);

/**
 * 記事の翻訳（docs/decisions/translation.md）。記事ごとに 1 行。全員で共有する。訳すかどうかを
 * 決めたときに作り、記事の行は変えない。記事の行が消えると、連鎖で消える。
 *
 * - queued：自動の翻訳を待っている（バッチ）。untranslated：訳文がない（まだ訳していない ／ 訳せなかった）。
 *   translating：その場の翻訳の最中。translated：訳文がある。skipped：日本語と決めた（配らず、訳さない）
 * - 状態は、もとの状態を書き込みと同じ文で確かめて移す（決定の 4〜7）
 */
export const articleTranslations = sqliteTable(
  "article_translations",
  {
    articleId: text("article_id")
      .primaryKey()
      .references(() => articles.id, { onDelete: "cascade" }),
    status: text("status", {
      enum: ["queued", "translating", "translated", "untranslated", "skipped"],
    }).notNull(),
    /** 決めたときの主言語（ISO 639-1、判定できなければ und） */
    language: text("language").notNull(),
    /** 訳したタイトルと要約（プレーンテキスト）。訳文がなければ null */
    title: text("title"),
    summary: text("summary"),
    /**
     * 訳した本文（サニタイズした HTML）。本文のない記事、長すぎる本文は null
     * （docs/decisions/translation.md の 3、12）
     */
    content: text("content"),
    /** 訳した本文の出どころ。訳した本文がなければ null */
    contentSource: text("content_source", { enum: ["feed", "page"] }),
    /** 訳したモデル。訳文がなければ null */
    model: text("model"),
    translatedAt: integer("translated_at", { mode: "timestamp_ms" }),
    /** その場の翻訳を始めた時刻。translating のあいだだけ。結果を書く文で同じかを確かめる */
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    /** その場の翻訳で、やり直せる失敗が続いた回数。始めるたびに 0 に戻す */
    attempts: integer("attempts").notNull().default(0),
    decidedAt: integer("decided_at", { mode: "timestamp_ms" }).notNull(),
    /**
     * バッチで送る印（docs/decisions/translation.md の 4）。送る行を取る文で、そのバッチの印と時刻を
     * 付ける。訳文を書いたとき、待ちに戻すときに外す。差分同期では配らない
     */
    batchKey: text("batch_key"),
    batchMarkedAt: integer("batch_marked_at", { mode: "timestamp_ms" }),
    /** 送れたバッチの ID。印を付けてから送れるまでは null */
    batchId: text("batch_id"),
    /** バッチで送った本文の出どころ（結果を組み立てるときに、同じ本文で分け直す）。本文を送らなければ null */
    batchContentSource: text("batch_content_source", { enum: ["feed", "page"] }),
    /**
     * バッチで送った断片の指紋（SHA-256）。結果を組み立てるときに分け直した断片と照らし、合わなければ
     * 本文を置かない（送ってから返るまでに、分け方が変わったとき）
     */
    batchBodyHash: text("batch_body_hash"),
    /** 本文断片の補完を始めた時刻。記事ごとに 1 回にするため、バッチの印を外したあとも残す */
    batchBodyRepairStartedAt: integer("batch_body_repair_started_at", { mode: "timestamp_ms" }),
    /**
     * バッチで訳せなかった回数（docs/decisions/translation.md の 4、8）。待てば通る失敗は数えない。
     * 上限で untranslated にする
     */
    batchAttempts: integer("batch_attempts").notNull().default(0),
    /**
     * 訳し直したかどうかの印（docs/decisions/translation.md の 6）。訳し直した訳文を書く文で付け、
     * 付いた記事は訳し直さない。差分同期で配る（同じく 14）
     */
    retranslated: integer("retranslated", { mode: "boolean" }).notNull().default(false),
    /**
     * 同じ元記事を見分ける、正規化した記事の URL（docs/decisions/translation.md の 16）。行を作る
     * ときに書く。使い回さない記事（URL がない、サイトの最初のページ、16 より前に作った行）は null
     */
    urlKey: text("url_key"),
    /**
     * 訳した（写した）ときに送った本文の指紋（サニタイズした HTML の SHA-256 の 16 進）。本文を
     * 送らなかったら "none"。16 より前に訳した行と、まだ訳していない行は null（同じく 16）
     */
    bodyHash: text("body_hash"),
    /**
     * バッチで送らずに、結果を書くときに同じ元記事から写す部分（1 タイトル、2 要約、4 本文の和。
     * 同じく 16）。送る印と一緒に付け、一緒に外す
     */
    batchCopies: integer("batch_copies").notNull().default(0),
    /**
     * 訳せなかった理由（docs/decisions/translation.md の 17）。訳そうとして untranslated にしたときに
     * 書き、translated にしたときに消す。untranslated のときだけ意味を持つ。拒否された（refused）か、
     * そのほかの失敗（failed）か
     */
    failureKind: text("failure_kind", { enum: ["refused", "failed"] }),
    /** 拒否の種類（拒否の応答の stop_details.category。なければ null。同じく 17） */
    failureCategory: text("failure_category"),
    /** どこで訳せなかったか（バッチか、その場の翻訳か。同じく 17） */
    failureStage: text("failure_stage", { enum: ["batch", "on_demand"] }),
    /**
     * 訳したときの条件（docs/decisions/translation.md の 18）。訳文の代表の部分（本文、本文がなければ
     * タイトル、それもなければ要約）を作ったものの、思考量・段階・プロンプトの版。送って訳したなら
     * その呼び出しの条件、同じ元記事から写したなら写した元の行の条件。モデルは model。訳文を書く文で
     * 一緒に書き、訳せなかったときは書き換えない。18 より前に訳した行は、思考量が low でほかは null。
     * モデルと思考量は差分同期で配り、GET でも返す。段階とプロンプトの版は配らない（同じく 14、18）
     */
    effort: text("effort", { enum: ["low", "medium", "high", "xhigh", "max"] }),
    tier: text("tier", { enum: ["normal", "long", "quality"] }),
    promptVersion: integer("prompt_version"),
    /**
     * 訳文を書いた呼び出しの入力・出力のトークン数と、その呼び出しのモデル（同じく 18）。送らずにすべて
     * 写した行と、訳し直しを広げた行は 0 で、呼び出しのモデルは null
     */
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    callModel: text("call_model"),
    /**
     * タイトル・要約・本文のそれぞれを、同じ元記事から写したときの、写した元の記事の ID（同じく 16、
     * 18）。送って訳した部分は null。写した元の記事が消えても残す（外部キーにしない）
     */
    titleCopiedFrom: text("title_copied_from"),
    summaryCopiedFrom: text("summary_copied_from"),
    contentCopiedFrom: text("content_copied_from"),
    /**
     * バッチで送った条件（段階・思考量・プロンプトの版。同じく 9）。送る印を付けるときに書き、結果を
     * 書く文で上の条件に写す。送る印と一緒に外す。差分同期では配らない
     */
    batchTier: text("batch_tier", { enum: ["normal", "long"] }),
    batchEffort: text("batch_effort", { enum: ["low", "medium", "high", "xhigh", "max"] }),
    batchPromptVersion: integer("batch_prompt_version"),
  },
  (t) => [
    index("article_translations_translating_idx")
      .on(t.startedAt)
      .where(sql`status = 'translating'`),
    index("article_translations_batch_idx").on(t.batchMarkedAt).where(sql`batch_key is not null`),
    // バッチで送る行を、決めた順に取る
    index("article_translations_batch_queue_idx")
      .on(t.decidedAt, t.articleId)
      .where(sql`status = 'queued' and batch_key is null`),
    // バッチの結果を書く行を、バッチの ID で引く
    index("article_translations_batch_id_idx").on(t.batchId).where(sql`batch_id is not null`),
    // 同じ元記事の行を引く（写す元を選ぶ、バッチで待つ）
    index("article_translations_url_key_idx")
      .on(t.urlKey, t.status)
      .where(sql`url_key is not null`),
    // 訳し直しを広げる元の行を引く（定期実行が、写し損ねた行を探す）
    index("article_translations_retranslated_idx")
      .on(t.urlKey, t.bodyHash)
      .where(sql`retranslated = 1`),
  ],
);

export type ArticleTranslation = typeof articleTranslations.$inferSelect;

/** FTS5 が参照する本文の写し。整数 ID は仮想表の rowid に使う。 */
export const articleSearchDocuments = sqliteTable("article_search_documents", {
  id: integer("id").primaryKey(),
  articleId: text("article_id")
    .notNull()
    .unique()
    .references(() => articles.id, { onDelete: "cascade" }),
  revision: text("revision").notNull(),
  content: text("content").notNull(),
  bytes: integer("bytes").notNull(),
});

/** 検索索引を作る順番と、UTC の日ごとの追加・更新件数。 */
export const articleSearchState = sqliteTable("article_search_state", {
  id: integer("id").primaryKey(),
  day: integer("day").notNull().default(-1),
  writes: integer("writes").notNull().default(0),
  backfillAfter: text("backfill_after"),
  backfillDone: integer("backfill_done", { mode: "boolean" }).notNull().default(false),
});

/** 索引の新規作成・更新を待つ記事。本文を読み出せないときは、再試行を遅らせる。 */
export const articleSearchPending = sqliteTable(
  "article_search_pending",
  {
    articleId: text("article_id")
      .primaryKey()
      .references(() => articles.id, { onDelete: "cascade" }),
    retryAt: integer("retry_at").notNull().default(0),
    queuedAt: integer("queued_at").notNull().default(0),
  },
  (t) => [
    index("article_search_pending_order_idx").on(t.retryAt, sql`${t.queuedAt} desc`, t.articleId),
  ],
);

/**
 * 本文の置き場の名前の書き留め（docs/decisions/content.md の 4）。「この名前の本文は、どの記事の
 * 行にも入っていないかもしれない」という印。置き場（ファイル）と DB を 1 つの文でまとめて書けないので、
 * 行のない本文が残りうる。それを、置き場を全部見て回らずに片付けるために持つ。
 *
 * - 取り込むとき：本文を置く前に書き、記事の行に入ったら消す（db/content.ts）
 * - 記事の行が消えたとき：表に付けたトリガーが、削除と同じ文の中で書く
 *   （migrations/0020_article_content_note_trigger.sql）
 * - 1 日 1 回の片付けが、1 時間より前の書き留めを見て、どの行にも入っていない名前の本文を消す
 */
export const contentNotes = sqliteTable("content_notes", {
  key: text("key").primaryKey(),
  /**
   * 書き留めた時刻。取得のジョブが動いている間のものを片付けないために使う。索引は付けない
   * （行は片付けですぐ消えるので少なく、索引の分の書き込みのほうが高くつく）
   */
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

/**
 * ユーザーの受信箱。購読しているフィードの記事が、人ごとに 1 行ずつ入る。既読とスターはここに持つ。
 *
 * 一覧と未読の数を、ユーザーの行だけを読んで返せるようにするため、記事の feed_id と
 * published_at を写して持つ（記事の表を全部なめない）。
 */
export const userArticles = sqliteTable(
  "user_articles",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    articleId: text("article_id")
      .notNull()
      .references(() => articles.id, { onDelete: "cascade" }),
    feedId: text("feed_id").notNull(),
    publishedAt: integer("published_at", { mode: "timestamp_ms" }).notNull(),
    /** 受信箱に入った時刻（DB の時計）。「一覧に出ていた記事だけを既読にする」の境界に使う */
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    /** 既読にした時刻。未読なら null */
    readAt: integer("read_at", { mode: "timestamp_ms" }),
    /** スターを付けた時刻。付いていなければ null */
    starredAt: integer("starred_at", { mode: "timestamp_ms" }),
    seq: seq(),
    /**
     * 既読・未読が最後に変わったときの変更番号（受信箱に入ったときを含む）。seq と違って、
     * スターを変えても変わらない。「同期で手元に届いた記事だけを既読にする」の境界に使う
     * （docs/decisions/sync.md の 6）。送り切った位置までにこの番号があり、今も未読の記事は、
     * 未読の状態で手元に届いている
     */
    readSeq: integer("read_seq").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.articleId] }),
    index("user_articles_user_id_published_at_idx").on(t.userId, t.publishedAt, t.articleId),
    index("user_articles_user_id_seq_idx").on(t.userId, t.seq),
    index("user_articles_seq_idx").on(t.seq),
    // 未読の数はその都度数える（docs/decisions/tech-stack.md）。未読の行だけを載せる
    index("user_articles_unread_idx").on(t.userId, t.feedId).where(sql`${t.readAt} is null`),
    index("user_articles_user_id_read_at_idx")
      .on(t.userId, t.readAt, t.articleId)
      .where(sql`${t.readAt} is not null`),
    index("user_articles_starred_idx")
      .on(t.userId, t.starredAt)
      .where(sql`${t.starredAt} is not null`),
    // 記事を消すとき、外部キーの確かめで、その記事を指す行を探す。これがないと、記事を 1 件
    // 消すたびに受信箱の表を全部読む（docs/decisions/retention.md の 6）
    index("user_articles_article_id_idx").on(t.articleId),
  ],
);

/**
 * 受信箱から消えた記事の記録（docs/decisions/sync.md の 3）。同期で、クライアントに記事ごとに
 * 「消えた」と伝えるために使う。
 *
 * 受信箱の行が物理的に消えると、表に付けたトリガーが削除と同じ文の中でここに書く。番号（seq）は
 * 受信箱の表の続きから振り、下限（seq_floors）もその番号まで引き上げるので、受信箱の行と番号が
 * 重ならない。同じ記事がまた消えたら、番号を振り直す。トリガーは
 * migrations/0005_user_article_removals_trigger.sql にある。
 *
 * 記事（共有）が消えても記録は残すので、記事への外部キーは付けない。
 */
export const userArticleRemovals = sqliteTable(
  "user_article_removals",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    articleId: text("article_id").notNull(),
    seq: integer("seq").notNull(),
    /** 消えた時刻（DB の時計）。記録の回収に使う */
    removedAt: integer("removed_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.articleId] }),
    index("user_article_removals_user_id_seq_idx").on(t.userId, t.seq),
  ],
);

/**
 * 変更番号の下限（docs/decisions/sync.md）。人ごとの表から行が物理的に消えると、表に付けた
 * トリガーが、消した行の番号でここを引き上げる。削除と同じ文の中で起きるので、間にほかの書き込みが
 * 入らず、番号が二度と使われない。トリガーは migrations/0001_seq_floor_triggers.sql にある
 * （drizzle-kit はトリガーを扱わないので、手で書いたマイグレーションにしている）。受信箱の
 * トリガーは、0005_user_article_removals_trigger.sql で消した記録も残す形に置き換えた
 */
export const seqFloors = sqliteTable("seq_floors", {
  tableName: text("table_name").primaryKey(),
  floor: integer("floor").notNull(),
});

/**
 * 受信箱の消した記録を、人ごとにどこまで回収したか（docs/decisions/sync.md の 3、retention.md の 5）。
 * 回収するとき、回収する記録の番号の最大まで、先にここを引き上げる。その人のカーソルの位置が
 * これより前なら、その先の消した記録が回収されているかもしれないので、最初から同期し直してもらう。
 *
 * 人ごとに持つのは、番号が受信箱の表全体で 1 つの並びだから。全員で 1 つにすると、受信箱の変わらない
 * 人のカーソルが、ほかの人の回収で古くなり、同期し直しを繰り返す
 */
export const removalHorizons = sqliteTable("removal_horizons", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  seq: integer("seq").notNull(),
});

/**
 * クライアントの設定（docs/decisions/settings.md）。ユーザー × 端末の種類ごとに、項目（名前）
 * ごとの行で持つ。値は JSON の文字列で、sendo は中身を解釈しない。
 *
 * 消すときは行を残し、消した印と新しい変更番号を付けて、値を捨てる。同じ名前でもう一度置くと、
 * 同じ行の印が外れる。印の行は 30 日たったら物理的に消す（db/settings.ts）。行が消えると、
 * トリガーが番号の下限を引き上げる（migrations/0018_client_settings_seq_floor_trigger.sql）
 */
export const clientSettings = sqliteTable(
  "client_settings",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** 端末の種類（mobile ／ desktop）。種類を足すときに表を変えずに済むよう、列は文字列にする */
    deviceType: text("device_type").notNull(),
    /** `<クライアント>.<残り>`。公式リーダーは reader. で始める */
    name: text("name").notNull(),
    /** JSON の文字列。消した印の行では null */
    value: text("value"),
    /** 名前と値のバイト数（UTF-8）。種類ごとの合計の上限に使う。消した印の行では 0 */
    size: integer("size").notNull(),
    seq: integer("seq").notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    uniqueIndex("client_settings_user_id_device_type_name_idx").on(t.userId, t.deviceType, t.name),
    index("client_settings_user_id_seq_idx").on(t.userId, t.seq),
  ],
);

/**
 * 設定の消した印の行を、人ごとにどこまで回収したか（docs/decisions/settings.md の 3）。
 * 回収する行の番号の最大まで、先にここを引き上げる。その人のカーソルの位置がこれより前なら、
 * 最初から同期し直してもらう。人ごとに持つ理由は removal_horizons と同じ
 */
export const settingHorizons = sqliteTable("setting_horizons", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  seq: integer("seq").notNull(),
});

/** 開封時に受信箱にあった記事の履歴。記事の片付け後も期限までは表示できる。 */
export const articleActivity = sqliteTable(
  "article_activity",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    id: text("id").notNull(),
    articleId: text("article_id").notNull(),
    articleTitle: text("article_title"),
    articleUrl: text("article_url"),
    occurredAt: integer("occurred_at", { mode: "timestamp_ms" }).notNull(),
    type: text("type", { enum: ["article_opened"] }).notNull(),
    source: text("source", { enum: ["reader"] }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.id] }),
    index("article_activity_user_time_idx").on(t.userId, t.occurredAt, t.id),
    index("article_activity_time_idx").on(t.occurredAt),
  ],
);

/** URL で保存したページ。解除するとメタデータは捨て、同期に必要な行だけを残す。 */
export const savedPages = sqliteTable(
  "saved_pages",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    id: text("id").notNull(),
    url: text("url"),
    title: text("title"),
    savedAt: integer("saved_at", { mode: "timestamp_ms" }),
    deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
    seq: seq(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.id] }),
    index("saved_pages_seq_idx").on(t.seq),
    index("saved_pages_user_seq_idx").on(t.userId, t.seq, t.id),
    index("saved_pages_user_saved_at_idx")
      .on(t.userId, t.savedAt, t.id)
      .where(sql`${t.deletedAt} is null`),
    index("saved_pages_deleted_at_idx").on(t.deletedAt).where(sql`${t.deletedAt} is not null`),
    check(
      "saved_pages_state_check",
      sql`(${t.deletedAt} is null and ${t.url} is not null and ${t.savedAt} is not null)
        or (${t.deletedAt} is not null and ${t.url} is null and ${t.title} is null and ${t.savedAt} is null)`,
    ),
  ],
);

export const savedPageHorizons = sqliteTable("saved_page_horizons", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  seq: integer("seq").notNull(),
});

/** null を空文字にそろえる式（coalesce(列, '') と同じ）。カンマを含まない形で書く */
const orEmpty = (column: AnySQLiteColumn) =>
  sql`(case when ${column} is null then '' else ${column} end)`;

/**
 * 通知のベル（docs/decisions/notifications.md の 1〜7）。購読と言葉の組で表す。購読だけ、言葉だけ、
 * 購読 AND 言葉の 3 つの種類は、2 つの列の有無で決まる。購読も言葉もない行は作らない。
 *
 * 外すと、行は残して消した印と新しい変更番号を付ける。付け直すと新しい行を作る。購読に消した印が
 * 付くと、トリガーが同じ文の中でその購読のベルにも印と番号を付ける。印の行は 30 日たったら
 * 物理的に消し、トリガーが人ごとの回収の下限を記録する（migrations/0071_bells-triggers.sql）
 */
export const bells = sqliteTable(
  "bells",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** 鳴らす購読。言葉だけのベルは null */
    subscriptionId: text("subscription_id").references(() => subscriptions.id, {
      onDelete: "cascade",
    }),
    /**
     * 当てる言葉。NFKC にして区切った言葉を、半角の空白 1 つでつないだもの（大文字と小文字は
     * 入れたまま）。言葉のないベルは null
     */
    words: text("words"),
    /**
     * 照合用の言葉。words の言葉を小文字にし、コードポイントの順に並べてつないだもの。言葉の並びに
     * よらず同じになる。言葉のないベルは null
     */
    matchKey: text("match_key"),
    /** 作った時刻。書く文の中の DB の時計（db/clock.ts の DB_NOW_MS）で決める */
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
    seq: seq(),
  },
  (t) => [
    // 同じ人で、購読と言葉の組が同じ有効なベルは 1 つ。付ける文はこれにぶつけて止める。SQLite の
    // 一意索引は null どうしを別の値とみなすので、空文字にそろえる。coalesce(列, '') と同じ式を
    // case で書くのは、drizzle-kit が索引の式をカンマで切ってしまい、正しい SQL を作れないため
    uniqueIndex("bells_user_id_subscription_id_match_key_idx")
      .on(t.userId, orEmpty(t.subscriptionId), orEmpty(t.matchKey))
      .where(sql`${t.deletedAt} is null`),
    // 購読をやめたときのトリガーと、外部キーの削除で使う
    index("bells_subscription_id_idx").on(t.subscriptionId),
    index("bells_user_id_seq_idx").on(t.userId, t.seq),
    index("bells_seq_idx").on(t.seq),
    index("bells_deleted_at_idx").on(t.deletedAt).where(sql`${t.deletedAt} is not null`),
  ],
);

/**
 * ベルの消した印の行を、人ごとにどこまで回収したか。行を消すトリガーが、消した行の番号まで
 * 引き上げる。その人のカーソルの位置がこれより前なら、最初から同期し直してもらう
 */
export const bellHorizons = sqliteTable("bell_horizons", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  seq: integer("seq").notNull(),
});

/**
 * 端末の Web Push の登録（docs/decisions/web-push.md の 4）。ブラウザのセッションに結ぶ。
 *
 * 1 つのセッションに 1 つ、1 つのエンドポイントに 1 つ。登録し直して中身が変わると、新しい ID の
 * 行に置き換える（db/push-registrations.ts）。セッションの行が消えると（ログアウト、別の人のログイン）、
 * 同じ文の中でこの行も消える。エンドポイントと鍵は秘密として扱い、ログと応答に出さない
 */
export const pushRegistrations = sqliteTable(
  "push_registrations",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    /** プッシュサービスの URL（toFetchableUrl で正規化した https の URL） */
    endpoint: text("endpoint").notNull(),
    /** 端末の公開鍵（P-256 の非圧縮の点 65 バイト）の base64url */
    p256dh: text("p256dh").notNull(),
    /** 認証の秘密（16 バイト）の base64url */
    auth: text("auth").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    uniqueIndex("push_registrations_session_id_idx").on(t.sessionId),
    uniqueIndex("push_registrations_endpoint_idx").on(t.endpoint),
    index("push_registrations_user_id_idx").on(t.userId),
  ],
);

/** 通知の行の状態（docs/decisions/notifications.md の 10） */
export const BELL_NOTIFICATION_STATES = ["sent", "limited", "bundled"] as const;

/**
 * ベルの通知の行（docs/decisions/notifications.md の 10〜13）。10 分の窓と 1 時間の上限を数える
 * ためだけに持ち、同期しない。1 日たった行は、1 日 1 回の片付けで消す。
 *
 * - 通知の記事の行（article_id あり）：当たった記事ごとに 1 つ。ユーザーと記事で一意（1 人 × 1 記事に
 *   1 通）
 * - 通知のまとめの行（article_id が null）：まとめた窓ごとに 1 つ。(ユーザー, ベル, 窓の始まり) で一意
 * - 状態：sent（送る）、limited（上限で送らない）、bundled（まとめに入れる。通知の記事の行だけ）。
 *   通知のまとめの行がまだない窓の bundled が、まとめ待ち
 * - 時刻は、書く文の中の DB の時計（db/clock.ts の DB_NOW_MS）で決める
 */
export const bellNotifications = sqliteTable(
  "bell_notifications",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    bellId: text("bell_id")
      .notNull()
      .references(() => bells.id, { onDelete: "cascade" }),
    /** 当たった記事。通知のまとめの行は null */
    articleId: text("article_id").references(() => articles.id, { onDelete: "cascade" }),
    /** 入った窓の始まり。窓を開いた通知の記事の行の、作った時刻 */
    windowStart: integer("window_start", { mode: "timestamp_ms" }).notNull(),
    /** 作った時刻。通知の記事の行では、当たった時刻 */
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    state: text("state", { enum: BELL_NOTIFICATION_STATES }).notNull(),
  },
  (t) => [
    // 1 人 × 1 記事に 1 つ。記事（articles）の行が消えたときの連鎖でも引く
    uniqueIndex("bell_notifications_article_id_user_id_idx").on(t.articleId, t.userId),
    // 通知のまとめの行は 1 つの窓に 1 つ
    uniqueIndex("bell_notifications_bundle_idx")
      .on(t.userId, t.bellId, t.windowStart)
      .where(sql`${t.articleId} is null`),
    // 窓と何件目かを数え、まとめの仕事が窓の行を読む。ベルの行が消えたときの連鎖でも引く
    index("bell_notifications_bell_id_window_start_idx").on(t.bellId, t.windowStart),
    // 1 時間の上限を数える
    index("bell_notifications_user_id_created_at_idx").on(t.userId, t.createdAt),
    // 1 日たった行を片付ける
    index("bell_notifications_created_at_idx").on(t.createdAt),
    check(
      "bell_notifications_state_check",
      sql`${t.state} in ('sent', 'limited', 'bundled')
        and (${t.state} <> 'bundled' or ${t.articleId} is not null)`,
    ),
  ],
);

/**
 * sendo が自分で作って持つ秘密（docs/decisions/images.md の 2）。画像の URL の署名の鍵と、VAPID の
 * 鍵の組（docs/decisions/web-push.md の 1）。初めて使うときに作る（db/secrets.ts）。行を消すと、
 * 次に使うときに作り直す
 */
export const appSecrets = sqliteTable("app_secrets", {
  name: text("name").primaryKey(),
  /** 署名の鍵は乱数を base64url にしたもの、VAPID の鍵の組は秘密の JWK の JSON */
  value: text("value").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

/**
 * 仕事の表（docs/decisions/container.md の 6）。
 *
 * 取り出すときに attempts を増やし、run_at を借りの期限まで先へ送る。終われば行を消し、失敗したら
 * run_at を少し先へ送ってやり直す。プロセスが途中で落ちても、借りの期限が過ぎればまた取り出される
 */
export const jobQueue = sqliteTable(
  "job_queue",
  {
    id: text("id").primaryKey(),
    /** 仕事（src/jobs/job.ts の Job）の JSON。取り出したあとで確かめる */
    job: text("job").notNull(),
    /** Discord の取得だけが持つ、直列に動かす単位 */
    discordFeedId: text("discord_feed_id"),
    /** 取り出した回数 */
    attempts: integer("attempts").notNull().default(0),
    /** この時刻を過ぎたら取り出してよい */
    runAt: integer("run_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("job_queue_run_at_idx").on(table.runAt),
    // Discord の購読ごとに未着手の仕事 1 つと、着手済みの仕事 1 つを持てる。
    uniqueIndex("job_queue_discord_slot_idx").on(table.discordFeedId, sql`(${table.attempts} > 0)`),
  ],
);

export type User = typeof users.$inferSelect;
export type PageContent = typeof pageContents.$inferSelect;
export type Identity = typeof identities.$inferSelect;
export type AccessToken = typeof accessTokens.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type OAuthRegisteredClient = typeof oauthClients.$inferSelect;
export type OAuthGrant = typeof oauthGrants.$inferSelect;
export type OAuthCode = typeof oauthCodes.$inferSelect;
export type OAuthToken = typeof oauthTokens.$inferSelect;
export type Folder = typeof folders.$inferSelect;
export type Workspace = typeof workspaces.$inferSelect;
export type Bell = typeof bells.$inferSelect;
export type Feed = typeof feeds.$inferSelect;
export type NewFeed = typeof feeds.$inferInsert;
export type Subscription = typeof subscriptions.$inferSelect;
export type Article = typeof articles.$inferSelect;
export type NewArticle = typeof articles.$inferInsert;
export type UserArticle = typeof userArticles.$inferSelect;

/** 本文を置く前の容量の確保。実際に消し終えるまで残す。null は既存本文の未集計 */
export const contentSizes = sqliteTable(
  "content_sizes",
  {
    key: text("key").primaryKey(),
    bytes: integer("bytes"),
    /** 本文と一緒に確保する記事情報と受信箱の分。記事を入れる同じ文で引き渡す */
    articleBytes: integer("article_bytes").notNull().default(0),
  },
  (t) => [index("content_sizes_unmeasured_idx").on(t.bytes).where(sql`bytes is null`)],
);

/** トリガーが書き込みと同時に更新する、記事の保管量。id = 1 の 1 行だけ */
export const storageUsage = sqliteTable("storage_usage", {
  id: integer("id").primaryKey(),
  bytes: integer("bytes").notNull().default(0),
  limitBytes: integer("limit_bytes")
    .notNull()
    .default(256 * 1024 * 1024),
  reclaiming: integer("reclaiming", { mode: "boolean" }).notNull().default(false),
  evictionDay: integer("eviction_day").notNull().default(-1),
  evictionBatches: integer("eviction_batches").notNull().default(0),
  /** 回収の所有権。期限切れの実行は、削除する文でもトークンを確かめて止める */
  reclaimToken: text("reclaim_token"),
  reclaimUntil: integer("reclaim_until").notNull().default(0),
});
