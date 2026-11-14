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
  },
  (t) => [index("access_tokens_user_id_idx").on(t.userId)],
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
    /** フィードに日付がなければ、取り込んだ時刻を入れる */
    publishedAt: integer("published_at", { mode: "timestamp_ms" }).notNull(),
    /** 取り込んだ時刻（DB の時計）。受信箱に配る範囲を決めるのに使う */
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    uniqueIndex("articles_feed_id_guid_idx").on(t.feedId, t.guid),
    index("articles_feed_id_created_at_idx").on(t.feedId, t.createdAt),
    index("articles_feed_id_published_at_idx").on(t.feedId, t.publishedAt),
  ],
);

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
     * 受信箱に入ったときの変更番号。seq と違って、既読やスターを変えても変わらない。
     * 「同期で手元に届いた記事だけを既読にする」の境界に使う（docs/decisions/sync.md の 6）
     */
    receivedSeq: integer("received_seq").notNull().default(0),
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
  ],
);

/**
 * 変更番号の下限（docs/decisions/sync.md）。人ごとの表から行が物理的に消えると、表に付けた
 * トリガーが、消した行の番号でここを引き上げる。削除と同じ文の中で起きるので、間にほかの書き込みが
 * 入らず、番号が二度と使われない。トリガーは migrations/0001_seq_floor_triggers.sql にある
 * （drizzle-kit はトリガーを扱わないので、手で書いたマイグレーションにしている）
 */
export const seqFloors = sqliteTable("seq_floors", {
  tableName: text("table_name").primaryKey(),
  floor: integer("floor").notNull(),
});

export type User = typeof users.$inferSelect;
export type Identity = typeof identities.$inferSelect;
export type AccessToken = typeof accessTokens.$inferSelect;
export type Folder = typeof folders.$inferSelect;
export type Feed = typeof feeds.$inferSelect;
export type NewFeed = typeof feeds.$inferInsert;
export type Subscription = typeof subscriptions.$inferSelect;
export type Article = typeof articles.$inferSelect;
export type NewArticle = typeof articles.$inferInsert;
export type UserArticle = typeof userArticles.$inferSelect;
