import { sql } from "drizzle-orm";
import { type Database, getRow } from ".";
import { DB_NOW_MS } from "./clock";
import { articleTagHorizons, articleTags } from "./schema";
import { nextSeq } from "./seq";

/*
 * 記事のタグ（docs/decisions/tags.md の 5〜8）。手の付け外しと取り消し。自動で付けるのは自動のタグ付けの仕事
 * （docs/decisions/auto-tagging.md）。
 */

/** 消した記事のタグの行を、同期のために残しておく長さ */
export const ARTICLE_TAG_REMOVAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** 記事のタグ。REST API、差分同期で返す形の元 */
export type ArticleTag = {
  id: string;
  tagId: string;
  articleId: string;
  kind: "auto" | "manual";
  on: boolean;
};

type ArticleTagRow = { id: string; tagId: string; articleId: string; kind: string; on: number };

const toArticleTag = (row: ArticleTagRow): ArticleTag => ({
  id: row.id,
  tagId: row.tagId,
  articleId: row.articleId,
  kind: row.kind === "manual" ? "manual" : "auto",
  on: row.on !== 0,
});

/** 本人の有効なタグで、記事が本人の受信箱にあること（書く文の中で確かめる） */
function ownTagAndInbox(input: { userId: string; articleId: string; tagId: string }) {
  return sql`exists (
      select 1 from tags t
      where t.id = ${input.tagId} and t.user_id = ${input.userId} and t.deleted_at is null
    ) and exists (
      select 1 from user_articles ua
      where ua.user_id = ${input.userId} and ua.article_id = ${input.articleId}
    )`;
}

/**
 * 手で付け外しする（docs/decisions/tags.md の 6）。行がなければ作り、あれば付け方を manual にして、消した
 * 印を外す。本人の有効なタグであることと、記事が本人の受信箱にあることを、同じ文の中で確かめる（作る文
 * でも、消した印の行を生き返らせる文でも）。変更番号は、見える状態が変わったときだけ振る。どちらかが違えば
 * not_found
 */
export async function setArticleTag(
  db: Database,
  input: { userId: string; articleId: string; tagId: string; on: boolean },
): Promise<ArticleTag | "not_found"> {
  const on = input.on ? 1 : 0;
  const row = await getRow<ArticleTagRow>(
    db,
    sql`insert into article_tags (id, tag_id, user_id, article_id, kind, "on", seq)
    select ${crypto.randomUUID()}, ${input.tagId}, ${input.userId}, ${input.articleId}, 'manual', ${on},
      ${nextSeq(articleTags)}
    where ${ownTagAndInbox(input)}
    on conflict (tag_id, article_id) do update set
      kind = 'manual', "on" = excluded."on", deleted_at = null,
      seq = case when article_tags.deleted_at is not null or article_tags.kind != 'manual'
          or article_tags."on" != excluded."on"
        then excluded.seq else article_tags.seq end
    returning id, tag_id as "tagId", article_id as "articleId", kind, "on"`,
  );
  return row ? toArticleTag(row) : "not_found";
}

/**
 * 手直しを取り消し、自動に戻す（docs/decisions/tags.md の 6）。変えるのは、手で付け外しした（manual で消した
 * 印のない）行だけで、付け方を auto に戻し、消した印と新しい変更番号を付ける。本人の有効なタグであることと、
 * 記事が本人の受信箱にあることを、書く文の中で確かめる。どちらかが違えば not_found。それ以外の行と、行が
 * ないときは何も変えずに cleared
 */
export async function clearArticleTag(
  db: Database,
  input: { userId: string; articleId: string; tagId: string },
): Promise<"cleared" | "not_found"> {
  const row = await getRow<{ id: string }>(
    db,
    sql`update article_tags set kind = 'auto', deleted_at = ${DB_NOW_MS}, seq = ${nextSeq(articleTags)}
    where tag_id = ${input.tagId} and article_id = ${input.articleId} and user_id = ${input.userId}
      and kind = 'manual' and deleted_at is null and ${ownTagAndInbox(input)}
    returning id`,
  );
  if (row) return "cleared";
  const found = await getRow<{ found: number }>(db, sql`select ${ownTagAndInbox(input)} as found`);
  return found?.found ? "cleared" : "not_found";
}

/** 本人の有効なタグか */
export async function isActiveTag(
  db: Database,
  input: { userId: string; tagId: string },
): Promise<boolean> {
  const row = await getRow<{ found: number }>(
    db,
    sql`select 1 as found from tags
    where id = ${input.tagId} and user_id = ${input.userId} and deleted_at is null`,
  );
  return row !== undefined;
}

/**
 * その人の、指定した記事の記事のタグ（消した印のない行。手で外したものも）を、記事の ID ごとに返す
 * （記事の一覧の項目に付ける。docs/decisions/tags.md の 6）
 */
export async function listArticleTagsFor(
  db: Database,
  input: { userId: string; articleIds: readonly string[] },
): Promise<Map<string, ArticleTag[]>> {
  const byArticle = new Map<string, ArticleTag[]>();
  if (input.articleIds.length === 0) return byArticle;
  const rows = await db.all<ArticleTagRow>(sql`
    select id, tag_id as "tagId", article_id as "articleId", kind, "on" from article_tags
    where user_id = ${input.userId} and deleted_at is null
      and article_id in (select value from json_each(${JSON.stringify(input.articleIds)}))
    order by seq, id
  `);
  for (const row of rows) {
    const list = byArticle.get(row.articleId) ?? [];
    list.push(toArticleTag(row));
    byArticle.set(row.articleId, list);
  }
  return byArticle;
}

/**
 * 消してから before より前の記事のタグの行を、物理的に消す。消す文の中で、トリガーが変更番号の下限と人ごとの
 * 回収の下限を引き上げる（migrations/0084_article-tags-triggers.sql）。
 *
 * @returns 消した行の数。limit と同じなら、まだ残っているかもしれない
 */
export async function collectRemovedArticleTags(
  db: Database,
  input: { before: Date; limit: number },
): Promise<number> {
  const rows = await db.all<{ id: string }>(sql`
    delete from article_tags
    where rowid in (
      select rowid from article_tags
      where deleted_at < ${input.before.getTime()}
      order by deleted_at limit ${input.limit}
    )
    returning id
  `);
  return rows.length;
}

/** その人の記事のタグの消した印の行を、どこまで回収したか。回収したことがなければ 0 */
export async function readArticleTagHorizon(db: Database, userId: string): Promise<number> {
  const row = await getRow<{ seq: number }>(
    db,
    sql`select seq from ${articleTagHorizons} where user_id = ${userId}`,
  );
  return row?.seq ?? 0;
}
