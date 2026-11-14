import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/** フィードをまとめるフォルダ（Feedly のカテゴリ、OPML の入れ子の outline）。1 つのフィードは 1 つのフォルダに入る */
export const folders = sqliteTable("folders", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

/** 購読しているフィード */
export const feeds = sqliteTable(
  "feeds",
  {
    id: text("id").primaryKey(),
    /** 取得に使う URL。正規化してから保存する */
    url: text("url").notNull().unique(),
    title: text("title"),
    siteUrl: text("site_url"),
    /**
     * 入っているフォルダ。フォルダを消すときは、先にこの列を null に戻す。
     * drizzle-kit は既存の表に列を足すときに ON DELETE を付けないので、DB には頼らない
     */
    folderId: text("folder_id").references(() => folders.id),
    /** 条件付き GET に使う。前回の応答の ETag ／ Last-Modified */
    etag: text("etag"),
    lastModified: text("last_modified"),
    lastFetchedAt: integer("last_fetched_at", { mode: "timestamp_ms" }),
    /** この時刻を過ぎたら、定期実行で取得のキューに積む */
    nextFetchAt: integer("next_fetch_at", { mode: "timestamp_ms" }).notNull(),
    /** 続けて失敗した回数。間隔を延ばすのに使い、成功したら 0 に戻す */
    errorCount: integer("error_count").notNull().default(0),
    lastError: text("last_error"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    index("feeds_next_fetch_at_idx").on(t.nextFetchAt),
    index("feeds_folder_id_idx").on(t.folderId),
  ],
);

/** フィードから取り込んだ記事 */
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
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    uniqueIndex("articles_feed_id_guid_idx").on(t.feedId, t.guid),
    index("articles_published_at_id_idx").on(t.publishedAt, t.id),
    index("articles_feed_id_published_at_id_idx").on(t.feedId, t.publishedAt, t.id),
  ],
);

export type Folder = typeof folders.$inferSelect;
export type Feed = typeof feeds.$inferSelect;
export type NewFeed = typeof feeds.$inferInsert;
export type Article = typeof articles.$inferSelect;
export type NewArticle = typeof articles.$inferInsert;
