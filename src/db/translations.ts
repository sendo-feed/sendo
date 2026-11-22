import { eq, sql } from "drizzle-orm";
import { type Database, getRow } from ".";
import { DB_NOW_MS } from "./clock";
import { type ArticleTranslation, articleTranslations } from "./schema";

/** 訳文の行の見積もり（行と主キー索引）。容量のトリガーと合わせる */
export const ARTICLE_TRANSLATION_BYTES = 512;

/** 1 回の仕事で、訳すかどうかを決める記事の数（docs/decisions/jobs.md の 4） */
export const DECIDE_BATCH_SIZE = 100;

/** 取り込んでから、ページの本文の判定を待つ長さ（docs/decisions/translation.md の 1） */
export const DECIDE_WAIT_MS = 60 * 60 * 1000;

/** 訳すかどうかを決める、取り込んでからの期限（同じく 1） */
export const DECIDE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** 始めてから、止まったものとして戻すまでの長さ（同じく 7） */
export const STALE_TRANSLATING_MS = 60 * 60 * 1000;

/** その場の翻訳で、やり直せる失敗を受け入れる回数（同じく 8、docs/decisions/jobs.md の 5） */
export const MAX_TRANSLATE_ATTEMPTS = 3;

const languageFrom = (source: string) => sql`(select l.language from article_languages l
  where l.article_id = a.id and l.source = ${source} and l.status in ('detected', 'provisional'))`;

/**
 * 訳すかどうかを決めて、行を作る（docs/decisions/translation.md の 1、2）。
 *
 * 決めるのは、言語の判定がページの本文まで済んだ記事か、取り込んでから 1 時間たって判定が 1 つでも
 * ある記事。Discord の投稿、取り込んでから 1 日たった記事、誰の受信箱にもない記事、行のある記事は
 * 決めない。行を作る文の中で、まだ行がないことを確かめる（重なった仕事が作り直さない）
 *
 * @returns 行を作った記事の数
 */
export async function decideTranslations(db: Database, limit = DECIDE_BATCH_SIZE) {
  // ページの判定が済んだ：ページの本文が抜けていて、その判定がある。抜けなかった、または URL のない
  // 記事は、フィードかタイトル・要約の判定がある
  const ready = sql`(
    exists (select 1 from article_languages l where l.article_id = a.id and l.source = 'page')
    or (
      (a.url is null or exists (
        select 1 from page_contents p where p.article_id = a.id
          and (p.status = 'failed' or p.html is null)
      ))
      and exists (select 1 from article_languages l where l.article_id = a.id
        and l.source in ('feed', 'metadata'))
    )
    or (a.created_at <= ${DB_NOW_MS} - ${DECIDE_WAIT_MS}
      and exists (select 1 from article_languages l where l.article_id = a.id))
  )`;
  const rows = await db.all<{ articleId: string }>(sql`
    insert into article_translations (article_id, status, language, decided_at)
    select c.id,
      case when c.lang is null then 'untranslated' when c.lang = 'ja' then 'skipped' else 'queued' end,
      coalesce(c.lang, 'und'), ${DB_NOW_MS}
    from (
      select a.id, coalesce(${languageFrom("page")}, ${languageFrom("feed")}, ${languageFrom("metadata")}) as lang
      from articles a join feeds f on f.id = a.feed_id
      where a.created_at > ${DB_NOW_MS} - ${DECIDE_WINDOW_MS}
        and f.discord_cursor is null
        and not exists (select 1 from article_translations t where t.article_id = a.id)
        and exists (select 1 from user_articles u where u.article_id = a.id)
        and ${ready}
      order by a.created_at, a.id
      limit ${limit}
    ) c
    where true
    on conflict (article_id) do nothing
    returning article_id as articleId
  `);
  return rows.length;
}

export function getTranslation(
  db: Database,
  articleId: string,
): Promise<ArticleTranslation | undefined> {
  return db
    .select()
    .from(articleTranslations)
    .where(eq(articleTranslations.articleId, articleId))
    .get();
}

/**
 * その場の翻訳を始める（docs/decisions/translation.md の 5）。queued ／ untranslated の行だけを、
 * 同じ文で translating にし、始めた時刻を書く。2 つの求めが重なっても、始められるのは 1 つ
 *
 * @returns 始めた時刻。始められなければ undefined
 */
export async function startTranslating(db: Database, articleId: string): Promise<Date | undefined> {
  const row = await getRow<{ startedAt: number }>(
    db,
    sql`update article_translations set status = 'translating', started_at = ${DB_NOW_MS}, attempts = 0
      where article_id = ${articleId} and status in ('queued', 'untranslated')
      returning started_at as startedAt`,
  );
  return row === undefined ? undefined : new Date(row.startedAt);
}

/** その場の翻訳の行が、始めたときのままか（ほかの書き込みや、止まったものとして戻されていないか） */
const stillTranslating = (articleId: string, startedAt: Date) =>
  sql`article_id = ${articleId} and status = 'translating' and started_at = ${startedAt.getTime()}`;

/**
 * その場の翻訳の結果を書く。始めた時刻が同じ行にだけ書く（戻したあとに終わった古い仕事は書かない）。
 * 容量が足りなければ、トリガーが書かない
 *
 * @returns 書いたら true
 */
export async function finishTranslating(
  db: Database,
  input: {
    articleId: string;
    startedAt: Date;
    title: string | null;
    summary: string | null;
    model: string;
  },
): Promise<boolean> {
  const row = await getRow<{ articleId: string }>(
    db,
    sql`update article_translations set status = 'translated', title = ${input.title},
        summary = ${input.summary}, model = ${input.model}, translated_at = ${DB_NOW_MS},
        started_at = null, attempts = 0
      where ${stillTranslating(input.articleId, input.startedAt)}
      returning article_id as articleId`,
  );
  return row !== undefined;
}

/** その場の翻訳を、訳せなかったものとして戻す。始めた時刻が同じ行だけ */
export async function failTranslating(
  db: Database,
  articleId: string,
  startedAt: Date,
): Promise<boolean> {
  const row = await getRow<{ articleId: string }>(
    db,
    sql`update article_translations set status = 'untranslated', started_at = null, attempts = 0
      where ${stillTranslating(articleId, startedAt)}
      returning article_id as articleId`,
  );
  return row !== undefined;
}

/** 始めたその場の翻訳を取り消し、始める前の状態に戻す（仕事を積めなかったとき）。始めた時刻が同じ行だけ */
export async function cancelTranslating(
  db: Database,
  articleId: string,
  startedAt: Date,
  status: "queued" | "untranslated",
): Promise<void> {
  await db.run(sql`update article_translations set status = ${status}, started_at = null, attempts = 0
    where ${stillTranslating(articleId, startedAt)}`);
}

/**
 * やり直せる失敗を 1 回数える。上限に達したら、同じ文で訳せなかったものとして戻す
 *
 * @returns まだやり直すなら "retry"、戻したなら "failed"、行が変わっていたら "gone"
 */
export async function countTranslateFailure(
  db: Database,
  articleId: string,
  startedAt: Date,
): Promise<"retry" | "failed" | "gone"> {
  const row = await getRow<{ status: string }>(
    db,
    sql`update article_translations set
        attempts = attempts + 1,
        status = case when attempts + 1 >= ${MAX_TRANSLATE_ATTEMPTS} then 'untranslated' else status end,
        started_at = case when attempts + 1 >= ${MAX_TRANSLATE_ATTEMPTS} then null else started_at end
      where ${stillTranslating(articleId, startedAt)}
      returning status`,
  );
  if (row === undefined) return "gone";
  return row.status === "translating" ? "retry" : "failed";
}

/**
 * 止まった translating を戻す（docs/decisions/translation.md の 7）。訳文があれば translated、
 * なければ untranslated にする
 *
 * @returns 戻した行の数
 */
export async function revertStaleTranslating(db: Database): Promise<number> {
  const rows = await db.all<{ articleId: string }>(sql`
    update article_translations set
      status = case when translated_at is null then 'untranslated' else 'translated' end,
      started_at = null, attempts = 0
    where status = 'translating' and started_at < ${DB_NOW_MS} - ${STALE_TRANSLATING_MS}
    returning article_id as articleId
  `);
  return rows.length;
}
