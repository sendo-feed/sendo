import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

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
 * アクセストークン（アプリ用パスワード）。REST API の Bearer と、リーダーアプリの
 * パスワード欄に使う。中身は持たず、SHA-256 のハッシュだけを置く。
 */
export const accessTokens = sqliteTable(
  "access_tokens",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** 用途の名前（「Reeder」「CLI」など） */
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    /** 最後に使った時刻。書き込みを減らすため、1 時間に 1 回だけ更新する */
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
    /**
     * 用途（docs/decisions/mcp.md の 2）。reader はリーダーアプリと REST API 用（アプリ用パスワード）、
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

/** フィード。全員で共有し、取得は 1 回だけ */
export const feeds = sqliteTable(
  "feeds",
  {
    id: text("id").primaryKey(),
    /** 取得に使う URL。正規化してから保存する */
    url: text("url").notNull().unique(),
    title: text("title"),
    siteUrl: text("site_url"),
    /** 条件付き GET に使う。前回の応答の ETag ／ Last-Modified */
    etag: text("etag"),
    lastModified: text("last_modified"),
    lastFetchedAt: integer("last_fetched_at", { mode: "timestamp_ms" }),
    /** この時刻を過ぎたら、定期実行で取得のキューに積む（購読している人がいるときだけ） */
    nextFetchAt: integer("next_fetch_at", { mode: "timestamp_ms" }).notNull(),
    /** 続けて失敗した回数。間隔を延ばすのに使い、成功したら 0 に戻す */
    errorCount: integer("error_count").notNull().default(0),
    lastError: text("last_error"),
    /**
     * どこまでの記事を、購読している人の受信箱に配ったか（記事の created_at）。
     * 配るのが途中で落ちても、次の取得でここから配り直せる
     */
    deliveredUntil: integer("delivered_until", { mode: "timestamp_ms" }),
    /**
     * 古い記事を、どこまで片付けたか（記事の created_at。docs/decisions/retention.md）。
     * 取得のたびに、取得の間隔の数倍の幅までずつ進める。null なら、まだ片付けていない
     * （フィードを登録した時刻から始める）
     */
    cleanedUntil: integer("cleaned_until", { mode: "timestamp_ms" }),
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
  (t) => [index("feeds_next_fetch_at_idx").on(t.nextFetchAt)],
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
    /** 取り込んだ時刻（DB の時計）。受信箱に配る範囲を決めるのに使う */
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    /**
     * Google Reader API のアイテムの ID（docs/decisions/greader.md の 3）。1 以上 2^53 未満の乱数で、
     * 取り込むときに db/articles.ts の insertArticles が振る。順に振らないのは、ID の飛びから
     * ほかの人が購読しているフィードの記事の数が分からないようにするため
     */
    itemId: integer("item_id").notNull().default(0),
    /**
     * フィードに入っていた本文の、置き場での名前（docs/decisions/content.md の 3）。本文がなければ
     * null。取り込むときに決まり、あとから変えない。名前は置くたびに乱数で決め、二度使わない。
     * API には、名前ではなく、本文があるかどうかだけを出す
     */
    contentKey: text("content_key"),
  },
  (t) => [
    // 本文のある記事だけを索引に入れる（片付けが、名前から記事の行があるかを引く）
    uniqueIndex("articles_content_key_idx").on(t.contentKey).where(sql`content_key is not null`),
    uniqueIndex("articles_feed_id_guid_idx").on(t.feedId, t.guid),
    uniqueIndex("articles_item_id_idx").on(t.itemId),
    index("articles_feed_id_created_at_idx").on(t.feedId, t.createdAt),
    index("articles_feed_id_published_at_idx").on(t.feedId, t.publishedAt),
  ],
);

/**
 * 本文の置き場の名前の書き留め（docs/decisions/content.md の 4）。「この名前の本文は、どの記事の
 * 行にも入っていないかもしれない」という印。置き場と D1 を 1 つの文でまとめて書けないので、
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
 * published_at を写して持つ（D1 は読んだ行の数で課金されるので、記事の表を全部なめない）。
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

/**
 * sendo が自分で作って持つ秘密（docs/decisions/images.md の 2）。今は、画像の URL の署名の鍵だけ。
 * 初めて使うときに作る（db/secrets.ts）。行を消すと、次に使うときに作り直す
 */
export const appSecrets = sqliteTable("app_secrets", {
  name: text("name").primaryKey(),
  /** 乱数を base64url にしたもの */
  value: text("value").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export type User = typeof users.$inferSelect;
export type Identity = typeof identities.$inferSelect;
export type AccessToken = typeof accessTokens.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type OAuthRegisteredClient = typeof oauthClients.$inferSelect;
export type OAuthGrant = typeof oauthGrants.$inferSelect;
export type OAuthCode = typeof oauthCodes.$inferSelect;
export type OAuthToken = typeof oauthTokens.$inferSelect;
export type Folder = typeof folders.$inferSelect;
export type Feed = typeof feeds.$inferSelect;
export type NewFeed = typeof feeds.$inferInsert;
export type Subscription = typeof subscriptions.$inferSelect;
export type Article = typeof articles.$inferSelect;
export type NewArticle = typeof articles.$inferInsert;
export type UserArticle = typeof userArticles.$inferSelect;
