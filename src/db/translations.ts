import { eq, inArray, sql } from "drizzle-orm";
import { normalizeSourceUrl } from "../translation/source-url";
import { type Database, getRow } from ".";
import { chunked } from "./chunk";
import { DB_NOW_MS } from "./clock";
import { type ArticleTranslation, articleTranslations, userArticles } from "./schema";

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

/** 1 つのバッチで送る記事の数（同じく 4） */
export const BATCH_SIZE = 100;

/** 1 回の定期実行で見にいくバッチの数（同じく 4） */
export const BATCH_CHECK_LIMIT = 10;

/** バッチで訳せなかった回数の上限。この回数目も訳せなければ untranslated にする（同じく 4、8） */
export const MAX_BATCH_ATTEMPTS = 3;

/** 印を付けてからバッチの ID がないまま、印を外すまでの長さ（同じく 4） */
export const BATCH_MARK_TTL_MS = 60 * 60 * 1000;

/** バッチの印を外す（待ちに戻す、訳文を書いた） */
const CLEAR_BATCH = sql`batch_key = null, batch_marked_at = null, batch_id = null,
  batch_content_source = null, batch_body_hash = null, batch_copies = 0`;

// --- 同じ元記事で写す（docs/decisions/translation.md の 16） ---

/** 写す部分（batch_copies の和） */
export const COPY_TITLE = 1;
export const COPY_SUMMARY = 2;
export const COPY_BODY = 4;

/** 本文を送らなかった行の指紋 */
export const NO_BODY_HASH = "none";

/** 写す元を選ぶ順：訳し直した行を先に、次に訳した時刻の新しい順 */
const SOURCE_ORDER = sql`order by s.retranslated desc, s.translated_at desc, s.article_id limit 1`;

/** 写す先の行（UPDATE の対象の行）と同じ元記事の、ほかの translated の行 */
const sameSource = sql`s.url_key = article_translations.url_key
  and s.article_id <> article_translations.article_id and s.status = 'translated'`;

/**
 * 写す元の行の id。タイトル：訳したタイトルがある。原文と同じ文字の訳（写す元がなくて原文を書いた
 * 行など）は、訳していないので写す元にしない
 */
const titleSourceId = sql`(select s.article_id from article_translations s
  join articles sa on sa.id = s.article_id
  where ${sameSource} and s.title is not null and s.title is not sa.title ${SOURCE_ORDER})`;

/** 写す元の行の id。要約：原文の要約の文字が同じ */
const summarySourceId = sql`(select s.article_id from article_translations s
  join articles sa on sa.id = s.article_id
  where ${sameSource} and s.summary is not null and s.summary is not sa.summary
    and sa.summary = (select ta.summary from articles ta where ta.id = article_translations.article_id)
  ${SOURCE_ORDER})`;

/** 写す元の行の id。本文：送る本文の指紋が同じ */
const bodySourceId = (
  bodyHash: string | null,
) => sql`(select s.article_id from article_translations s
  where ${sameSource} and s.body_hash = ${bodyHash} and s.content is not null ${SOURCE_ORDER})`;

const columnOf = (column: string, sourceId: ReturnType<typeof sql>) =>
  sql`(select c.${sql.raw(column)} from article_translations c where c.article_id = ${sourceId})`;

/**
 * 同じ元記事から写せる部分（COPY_* の和）。送る前に、送るものと分けるために読む。写すのは結果を書く
 * 文の中で、写す元を選び直す（決定の 16）。正規化した URL のない行は 0
 */
export async function findCopies(
  db: Database,
  articleId: string,
  bodyHash: string | null,
): Promise<number> {
  const body = bodyHash === null || bodyHash === NO_BODY_HASH ? null : bodyHash;
  const row = await getRow<{ copies: number }>(
    db,
    sql`select
        (case when ${titleSourceId} is not null then ${COPY_TITLE} else 0 end)
        + (case when ${summarySourceId} is not null then ${COPY_SUMMARY} else 0 end)
        + (case when ${body} is not null and ${bodySourceId(body)} is not null
            then ${COPY_BODY} else 0 end) as copies
      from article_translations
      where article_id = ${articleId} and url_key is not null`,
  );
  return row?.copies ?? 0;
}

/**
 * 写す部分と送った訳から、書く列を組み立てる（UPDATE の SET に入れる）。写す元がなくなっていたら、
 * タイトル・要約は原文の文字、本文は置かない（決定の 16）
 */
function translatedColumns(input: {
  copies: number;
  title: string | null;
  summary: string | null;
  originalTitle: string | null;
  originalSummary: string | null;
  content: { html: string; source: "feed" | "page" } | null;
  /** 本文の出どころ（写すときも、その記事が 3 で選んだもの） */
  bodySource: "feed" | "page" | null;
  bodyHash: string;
}) {
  const copyBody = (input.copies & COPY_BODY) !== 0;
  const bodySrc = bodySourceId(input.bodyHash);
  const title =
    (input.copies & COPY_TITLE) !== 0
      ? sql`coalesce(${columnOf("title", titleSourceId)}, ${input.originalTitle})`
      : sql`${input.title}`;
  const summary =
    (input.copies & COPY_SUMMARY) !== 0
      ? sql`coalesce(${columnOf("summary", summarySourceId)}, ${input.originalSummary})`
      : sql`${input.summary}`;
  const content = copyBody ? columnOf("content", bodySrc) : sql`${input.content?.html ?? null}`;
  const contentSource = copyBody
    ? sql`case when ${columnOf("content", bodySrc)} is null then null else ${input.bodySource} end`
    : sql`${input.content?.source ?? null}`;
  // 本文（本文がなければタイトル）を訳し直した行から写したら、訳し直しの印も付ける
  const retranslated = copyBody
    ? sql`coalesce(${columnOf("retranslated", bodySrc)}, 0)`
    : input.bodyHash === NO_BODY_HASH && (input.copies & COPY_TITLE) !== 0
      ? sql`coalesce(${columnOf("retranslated", titleSourceId)}, 0)`
      : sql`0`;
  return { title, summary, content, contentSource, retranslated, bodySrc };
}

const languageFrom = (source: string) => sql`(select l.language from article_languages l
  where l.article_id = a.id and l.source = ${source} and l.status in ('detected', 'provisional'))`;

/**
 * 訳すかどうかを決めて、行を作る（docs/decisions/translation.md の 1、2）。
 *
 * 決めるのは、言語の判定がページの本文まで済んだ記事か、取り込んでから 1 時間たって判定が 1 つでも
 * ある記事。Discord の投稿、取り込んでから 1 日たった記事、誰の受信箱にもない記事、行のある記事は
 * 決めない。行を作る文の中で、まだ行がないことを確かめる（重なった仕事が作り直さない）
 *
 * @returns 行を作った記事。差分同期で配る（skipped でない）ものかどうかも返す
 */
export async function decideTranslations(
  db: Database,
  limit = DECIDE_BATCH_SIZE,
): Promise<{ articleId: string; delivered: boolean }[]> {
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
  const rows = await db.all<{ articleId: string; status: string }>(sql`
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
    returning article_id as articleId, status
  `);
  // 同じ元記事を見分ける、正規化した URL を書く（決定の 16）。行を作るのは、ここだけにする（ほかの
  // 呼び出し元も URL を書き漏らさないように）。行を作る文のあとなので、その間に落ちた行は書かれず、
  // 使い回さない（訳すのは今までどおり）
  const delivered = rows.filter((row) => row.status !== "skipped").map((row) => row.articleId);
  await setUrlKeys(
    db,
    (await listArticleUrls(db, delivered)).flatMap((row) => {
      const urlKey = normalizeSourceUrl(row.url);
      return urlKey === null ? [] : [{ articleId: row.id, urlKey }];
    }),
  );
  return rows.map((row) => ({ articleId: row.articleId, delivered: row.status !== "skipped" }));
}

/**
 * 作った行に、同じ元記事を見分ける正規化した URL を書く（docs/decisions/translation.md の 16）。
 * まだ書いていない行だけに書く（何度動いても同じ結果）。正規化は呼んだ側が行う
 */
export async function setUrlKeys(
  db: Database,
  keys: readonly { articleId: string; urlKey: string }[],
): Promise<void> {
  for (const { articleId, urlKey } of keys) {
    await db.run(sql`update article_translations set url_key = ${urlKey}
      where article_id = ${articleId} and url_key is null`);
  }
}

/** 記事の URL（正規化した URL を書くために読む） */
export async function listArticleUrls(
  db: Database,
  articleIds: readonly string[],
): Promise<{ id: string; url: string | null }[]> {
  const rows: { id: string; url: string | null }[] = [];
  for (const ids of chunked(articleIds, null)) {
    rows.push(
      ...(await db.all<{ id: string; url: string | null }>(sql`
      select id, url from articles where id in (select value from json_each(${JSON.stringify(ids)}))`)),
    );
  }
  return rows;
}

/**
 * 記事を受信箱に持つ人（翻訳が変わったことを知らせる相手。docs/decisions/sync.md の 9、10）
 */
export async function listArticleHolders(
  db: Database,
  articleIds: readonly string[],
): Promise<string[]> {
  const userIds = new Set<string>();
  for (const ids of chunked(articleIds, null)) {
    const rows = await db
      .selectDistinct({ userId: userArticles.userId })
      .from(userArticles)
      .where(inArray(userArticles.articleId, ids))
      .all();
    for (const row of rows) userIds.add(row.userId);
  }
  return [...userIds];
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

/**
 * 訳し直しを始める（docs/decisions/translation.md の 6）。translated で訳し直しの印のない行だけを、
 * 同じ文で translating にし、始めた時刻を書く。もとの訳文は、訳し直した訳文が入るまで残す。2 つの
 * 求めが重なっても、始められるのは 1 つ
 *
 * @returns 始めた時刻。始められなければ undefined
 */
export async function startRetranslating(
  db: Database,
  articleId: string,
): Promise<Date | undefined> {
  const row = await getRow<{ startedAt: number }>(
    db,
    sql`update article_translations set status = 'translating', started_at = ${DB_NOW_MS}, attempts = 0
      where article_id = ${articleId} and status = 'translated' and retranslated = 0
      returning started_at as startedAt`,
  );
  return row === undefined ? undefined : new Date(row.startedAt);
}

/**
 * 訳せなかったときに戻す状態。訳文があれば（訳し直しの失敗）もとの訳文のまま translated、なければ
 * untranslated（docs/decisions/translation.md の 5、6）
 */
const STATUS_WITHOUT_RESULT = sql`case when translated_at is null then 'untranslated' else 'translated' end`;

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
    /** 訳した本文（サニタイズした HTML）と出どころ。本文を訳さなかったら null */
    content: { html: string; source: "feed" | "page" } | null;
    model: string;
    /** 訳し直しなら、訳し直しの印を付ける（docs/decisions/translation.md の 6） */
    retranslation?: boolean;
    /** 送った本文の指紋（決定の 16） */
    bodyHash: string;
    /** 送らずに同じ元記事から写す部分（決定の 16）。写す元はこの文の中で選び直す */
    copies?: number;
    originalTitle?: string | null;
    originalSummary?: string | null;
    bodySource?: "feed" | "page" | null;
  },
): Promise<boolean> {
  const copies = input.copies ?? 0;
  const c = translatedColumns({
    copies,
    title: input.title,
    summary: input.summary,
    content: input.content,
    originalTitle: input.originalTitle ?? null,
    originalSummary: input.originalSummary ?? null,
    bodySource: input.bodySource ?? null,
    bodyHash: input.bodyHash,
  });
  const retranslated =
    input.retranslation === true ? sql`1` : copies !== 0 ? c.retranslated : sql`retranslated`;
  const row = await getRow<{ articleId: string }>(
    db,
    // バッチの印も同じ文で外す（あとで返ったバッチの結果を捨てる。docs/decisions/translation.md の 5）
    sql`update article_translations set status = 'translated', title = ${c.title},
        summary = ${c.summary}, content = ${c.content}, content_source = ${c.contentSource},
        model = ${input.model}, translated_at = ${DB_NOW_MS}, started_at = null, attempts = 0,
        retranslated = ${retranslated}, body_hash = ${input.bodyHash}, ${CLEAR_BATCH}
      where ${stillTranslating(input.articleId, input.startedAt)}
      returning article_id as articleId`,
  );
  return row !== undefined;
}

/**
 * その場の翻訳で、すべて写せる記事を、呼ばずに写して translated にする（決定の 16）。始めた時刻が
 * 同じ行だけ。写す元をこの文の中で選び直し、写すと決めた部分の写す元がなくなっていたら書かない。
 * 容量が足りなければ、トリガーが書かない
 *
 * @returns 書いたら true
 */
export async function finishCopiedTranslating(
  db: Database,
  input: {
    articleId: string;
    startedAt: Date;
    copies: number;
    originalTitle: string | null;
    originalSummary: string | null;
    bodySource: "feed" | "page" | null;
    bodyHash: string;
  },
): Promise<boolean> {
  const c = translatedColumns({ ...input, title: null, summary: null, content: null });
  const need = (flag: number, sourceId: ReturnType<typeof sql>) =>
    (input.copies & flag) !== 0 ? sql`and ${sourceId} is not null` : sql``;
  const row = await getRow<{ articleId: string }>(
    db,
    sql`update article_translations set status = 'translated', title = ${c.title},
        summary = ${c.summary}, content = ${c.content}, content_source = ${c.contentSource},
        model = coalesce(${columnOf("model", c.bodySrc)}, ${columnOf("model", titleSourceId)},
          ${columnOf("model", summarySourceId)}),
        retranslated = ${c.retranslated}, body_hash = ${input.bodyHash},
        translated_at = ${DB_NOW_MS}, started_at = null, attempts = 0, ${CLEAR_BATCH}
      where ${stillTranslating(input.articleId, input.startedAt)}
        ${need(COPY_TITLE, titleSourceId)} ${need(COPY_SUMMARY, summarySourceId)}
        ${need(COPY_BODY, c.bodySrc)}
      returning article_id as articleId`,
  );
  return row !== undefined;
}

/** 1 回に訳し直しを写す行の数の上限（残りは次の定期実行。docs/decisions/jobs.md の 4） */
export const RETRANSLATION_COPY_LIMIT = 100;

/**
 * 写す元（s）の訳し直しで、写す先（t）の本文を置き換えられる。写す先に訳した本文があるのに、写す元
 * に訳し直した本文がない（訳し直した本文が上限を超えて置けなかった）なら写さない。Sonnet の本文を
 * 残したまま印を付けると、その本文を二度と訳し直せないため（決定の 6）
 */
const replacesBody = sql`(s.content is not null or t.content is null)`;

/**
 * 訳し直しを写す先の行（docs/decisions/translation.md の 16）。同じ正規化した URL で、本文の指紋が
 * 同じ（どちらも「本文なし」を含む）訳し直した行がある、translated で訳し直しの印のない行。指紋の
 * ない行は写す先にしない。訳した本文のある行は、訳し直した本文のある写す元があるときだけ。
 * sourceId を渡したら、その行を写す元にできる行だけ
 */
export async function listRetranslationTargets(
  db: Database,
  options: { sourceId?: string | undefined; limit?: number } = {},
): Promise<string[]> {
  const rows = await db.all<{ articleId: string }>(
    // 訳し直した行（部分索引）を外側にして、同じ正規化した URL の行を引く（訳文の表の全部をなめない）
    sql`select distinct t.article_id as articleId from article_translations s
      cross join article_translations t on t.url_key = s.url_key and t.body_hash = s.body_hash
        and t.article_id <> s.article_id
      where s.retranslated = 1 and s.status = 'translated' and s.url_key is not null
        ${options.sourceId === undefined ? sql`` : sql`and s.article_id = ${options.sourceId}`}
        and t.status = 'translated' and t.retranslated = 0
        and ${replacesBody}
      order by t.article_id
      limit ${options.limit ?? RETRANSLATION_COPY_LIMIT}`,
  );
  return rows.map((row) => row.articleId);
}

/**
 * 1 つの行に、同じ元記事の訳し直した訳を写す（決定の 16）。写す元（同じ正規化した URL で本文の指紋が
 * 同じ、訳し直した行。原文の要約が同じもの、次に新しく訳したものを先に）と写す先（translated で
 * 訳し直しの印がない）を、この文の中で確かめる。タイトルと本文を写し、原文の要約が同じなら要約も
 * 写して、訳した時刻・モデル・訳し直しの印を写す元と同じにする。写す元が訳していない部分（原文と
 * 同じ文字、本文がない）と、原文にタイトルのない記事のタイトルは写さない。写す先に訳した本文があり、
 * 写す元に訳し直した本文がなければ写さない。容量が足りなければ、トリガーが書かない
 *
 * @returns 写したら true
 */
export async function copyRetranslation(db: Database, articleId: string): Promise<boolean> {
  const row = await getRow<{ articleId: string }>(
    db,
    sql`update article_translations as t set
        title = case when s.title is not null and s.title is not sa.title
          and trim(coalesce(ta.title, '')) <> '' then s.title else t.title end,
        summary = case when sa.summary = ta.summary and s.summary is not null
          and s.summary is not sa.summary then s.summary else t.summary end,
        content = coalesce(s.content, t.content),
        content_source = case when s.content is null then t.content_source
          else coalesce(t.content_source, s.content_source) end,
        model = s.model, translated_at = s.translated_at, retranslated = 1
      from article_translations s
        join articles sa on sa.id = s.article_id
        join articles ta on ta.id = ${articleId}
      where t.article_id = ${articleId} and t.status = 'translated' and t.retranslated = 0
        and s.article_id = (select r.article_id from article_translations r
          join articles ra on ra.id = r.article_id
          where r.url_key = t.url_key and r.body_hash = t.body_hash and r.article_id <> t.article_id
            and r.status = 'translated' and r.retranslated = 1
            and (r.content is not null or t.content is null)
          -- 写した行も写す元になるので、原文の要約が同じ行を先に選ぶ（要約も写せるように）
          order by ra.summary is (select x.summary from articles x where x.id = ${articleId}) desc,
            r.translated_at desc, r.article_id limit 1)
      returning article_id as articleId`,
  );
  return row !== undefined;
}

/**
 * その場の翻訳を、訳せなかったものとして戻す。訳し直しなら、もとの訳文のまま translated に戻す
 * （印は付けない）。始めた時刻が同じ行だけ
 */
export async function failTranslating(
  db: Database,
  articleId: string,
  startedAt: Date,
): Promise<boolean> {
  const row = await getRow<{ articleId: string }>(
    db,
    sql`update article_translations set status = ${STATUS_WITHOUT_RESULT}, started_at = null, attempts = 0
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
  status: "queued" | "untranslated" | "translated",
): Promise<void> {
  await db.run(sql`update article_translations set status = ${status}, started_at = null, attempts = 0
    where ${stillTranslating(articleId, startedAt)}`);
}

/**
 * やり直せる失敗を 1 回数える。上限に達したら、同じ文で訳せなかったものとして戻す（訳し直しなら、
 * もとの訳文のまま translated）
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
        status = case when attempts + 1 >= ${MAX_TRANSLATE_ATTEMPTS} then ${STATUS_WITHOUT_RESULT} else status end,
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
 * @returns 戻した記事
 */
export async function revertStaleTranslating(db: Database): Promise<string[]> {
  const rows = await db.all<{ articleId: string }>(sql`
    update article_translations set
      status = ${STATUS_WITHOUT_RESULT}, started_at = null, attempts = 0
    where status = 'translating' and started_at < ${DB_NOW_MS} - ${STALE_TRANSLATING_MS}
    returning article_id as articleId
  `);
  return rows.map((row) => row.articleId);
}

// --- バッチ（docs/decisions/translation.md の 4） ---

/**
 * 印を付けてから 1 時間たってもバッチの ID がない行の印を外し、待ちに戻す（バッチを作る途中で
 * 落ちた、作れたか分からない）
 */
export async function releaseStaleBatchMarks(db: Database): Promise<number> {
  const rows = await db.all<{ articleId: string }>(sql`
    update article_translations set ${CLEAR_BATCH}
    where batch_key is not null and batch_id is null
      and batch_marked_at <= ${DB_NOW_MS} - ${BATCH_MARK_TTL_MS}
    returning article_id as articleId
  `);
  return rows.length;
}

/**
 * queued で印のない行を limit 件まで、同じ文で印（key と時刻）を付けて取る。重なった定期実行は、
 * 同じ行に印を付けない。
 *
 * 同じ元記事（正規化した URL が同じ）の行がバッチの印を持っている間は取らずに待つ。印のない同じ元記事
 * の行どうしでは、バッチで訳せなかった回数の少ない順、次に決めた順で 1 つだけを取る（決定の 16。
 * 本文を重ねて送らない）。どちらも、この文の中で確かめる
 *
 * @returns 印を付けた記事
 */
export async function markForBatch(
  db: Database,
  key: string,
  limit = BATCH_SIZE,
): Promise<string[]> {
  const rows = await db.all<{ articleId: string }>(sql`
    update article_translations set batch_key = ${key}, batch_marked_at = ${DB_NOW_MS}
    where article_id in (
      select c.article_id from article_translations c
      where c.status = 'queued' and c.batch_key is null
        and (c.url_key is null or (
          not exists (select 1 from article_translations o
            where o.url_key = c.url_key and o.batch_key is not null)
          and not exists (select 1 from article_translations o
            where o.url_key = c.url_key and o.article_id <> c.article_id
              and o.status = 'queued' and o.batch_key is null
              and (o.batch_attempts < c.batch_attempts
                or (o.batch_attempts = c.batch_attempts and (o.decided_at < c.decided_at
                  or (o.decided_at = c.decided_at and o.article_id < c.article_id)))))
        ))
      order by c.decided_at, c.article_id
      limit ${limit}
    ) and status = 'queued' and batch_key is null
    returning article_id as articleId
  `);
  return rows.map((row) => row.articleId);
}

/** バッチで送る本文の出どころと、送る断片の指紋を書き留める（印が同じ行だけ） */
export async function setBatchBody(
  db: Database,
  articleId: string,
  key: string,
  body: { source: "feed" | "page" | null; hash: string | null; copies: number },
): Promise<void> {
  await db.run(sql`update article_translations
    set batch_content_source = ${body.source}, batch_body_hash = ${body.hash},
      batch_copies = ${body.copies}
    where article_id = ${articleId} and batch_key = ${key}`);
}

/**
 * 送る印を付けた行のうち、すべて写せる行を、送らずに写して translated にする（決定の 16）。写す元を
 * この文の中で選び直し、写すと決めた部分の写す元がなくなっていたら書かない（呼んだ側が待ちに戻す）。
 * 容量が足りなければ、トリガーが書かない
 *
 * @returns 書いたら true
 */
export async function finishCopiedBatchArticle(
  db: Database,
  input: {
    articleId: string;
    key: string;
    copies: number;
    originalTitle: string | null;
    originalSummary: string | null;
    bodySource: "feed" | "page" | null;
    bodyHash: string;
  },
): Promise<boolean> {
  const c = translatedColumns({ ...input, title: null, summary: null, content: null });
  const need = (flag: number, sourceId: ReturnType<typeof sql>) =>
    (input.copies & flag) !== 0 ? sql`and ${sourceId} is not null` : sql``;
  const row = await getRow<{ articleId: string }>(
    db,
    sql`update article_translations set status = 'translated', title = ${c.title},
        summary = ${c.summary}, content = ${c.content}, content_source = ${c.contentSource},
        model = coalesce(${columnOf("model", c.bodySrc)}, ${columnOf("model", titleSourceId)},
          ${columnOf("model", summarySourceId)}),
        retranslated = ${c.retranslated}, body_hash = ${input.bodyHash},
        translated_at = ${DB_NOW_MS}, started_at = null, attempts = 0, ${CLEAR_BATCH}
      where article_id = ${input.articleId} and batch_key = ${input.key} and batch_id is null
        and status = 'queued' and translated_at is null
        ${need(COPY_TITLE, titleSourceId)} ${need(COPY_SUMMARY, summarySourceId)}
        ${need(COPY_BODY, c.bodySrc)}
      returning article_id as articleId`,
  );
  return row !== undefined;
}

/** 送れたバッチの ID を、印が同じ行に書き留める */
export async function setBatchId(db: Database, key: string, batchId: string): Promise<void> {
  await db.run(sql`update article_translations set batch_id = ${batchId}
    where batch_key = ${key} and batch_id is null`);
}

/** 送らなかった印を外し、待ちに戻す（バッチの ID がない、印が同じ行だけ） */
export async function unmarkBatch(
  db: Database,
  key: string,
  articleIds?: readonly string[],
): Promise<void> {
  if (articleIds === undefined) {
    await db.run(sql`update article_translations set ${CLEAR_BATCH}
      where batch_key = ${key} and batch_id is null`);
    return;
  }
  await db.run(sql`update article_translations set ${CLEAR_BATCH}
    where batch_key = ${key} and batch_id is null
      and article_id in (select value from json_each(${JSON.stringify(articleIds)}))`);
}

/** 見にいくバッチ（印を付けたのが古い順に limit 個まで） */
export async function listBatchesToCheck(
  db: Database,
  limit = BATCH_CHECK_LIMIT,
): Promise<string[]> {
  const rows = await db.all<{ batchId: string }>(sql`
    select batch_id as batchId from article_translations
    where batch_key is not null and batch_id is not null
    group by batch_id
    order by min(batch_marked_at), batch_id
    limit ${limit}
  `);
  return rows.map((row) => row.batchId);
}

/** そのバッチの印を持つ行（結果を書く前に、送った本文の出どころを読む） */
export function listBatchRows(
  db: Database,
  batchId: string,
): Promise<
  {
    articleId: string;
    contentSource: "feed" | "page" | null;
    bodyHash: string | null;
    copies: number;
  }[]
> {
  return db
    .select({
      articleId: articleTranslations.articleId,
      contentSource: articleTranslations.batchContentSource,
      bodyHash: articleTranslations.batchBodyHash,
      copies: articleTranslations.batchCopies,
    })
    .from(articleTranslations)
    .where(eq(articleTranslations.batchId, batchId))
    .all();
}

/**
 * バッチの結果を書く。行がそのバッチの印を持ち、まだ訳文がないときだけ書き、印を外して translated に
 * する（同じ文で確かめる）。その場の翻訳の最中なら、それも終える。容量が足りなければ、トリガーが
 * 書かない（印は残る）
 *
 * @returns 書いたら true
 */
export async function finishBatchTranslation(
  db: Database,
  input: {
    articleId: string;
    batchId: string;
    title: string | null;
    summary: string | null;
    content: { html: string; source: "feed" | "page" } | null;
    model: string;
    /** 送らずに同じ元記事から写す部分（決定の 16）。写す元はこの文の中で選び直す */
    copies: number;
    originalTitle: string | null;
    originalSummary: string | null;
    bodySource: "feed" | "page" | null;
    /** 送った（写した）本文の指紋 */
    bodyHash: string;
  },
): Promise<boolean> {
  const c = translatedColumns(input);
  const row = await getRow<{ articleId: string }>(
    db,
    sql`update article_translations set status = 'translated', title = ${c.title},
        summary = ${c.summary}, content = ${c.content}, content_source = ${c.contentSource},
        model = ${input.model}, retranslated = ${c.retranslated}, body_hash = ${input.bodyHash},
        translated_at = ${DB_NOW_MS}, started_at = null, attempts = 0, ${CLEAR_BATCH}
      where article_id = ${input.articleId} and batch_id = ${input.batchId}
        and translated_at is null and status in ('queued', 'untranslated', 'translating')
      returning article_id as articleId`,
  );
  return row !== undefined;
}

/**
 * そのバッチの印を外し、待ちに戻す（印が同じ行だけ）。keep の記事は印を残す（容量が足りずに書けず、
 * 次の定期実行で書き直す）
 */
export async function unmarkCheckedBatch(
  db: Database,
  batchId: string,
  keep: readonly string[] = [],
): Promise<void> {
  await db.run(sql`update article_translations set ${CLEAR_BATCH}
    where batch_id = ${batchId}
      and article_id not in (select value from json_each(${JSON.stringify(keep)}))`);
}

/**
 * 送る印を付けたが、訳すもの（タイトル、要約、本文）がない記事を、訳せないもの（untranslated）にして
 * 印を外す（印が同じ queued の行だけ）
 *
 * @returns 変えた記事
 */
export async function skipEmptyBatchArticles(
  db: Database,
  key: string,
  articleIds: readonly string[],
): Promise<string[]> {
  if (articleIds.length === 0) return [];
  const rows = await db.all<{ articleId: string }>(sql`
    update article_translations set status = 'untranslated', ${CLEAR_BATCH}
    where batch_key = ${key} and batch_id is null and status = 'queued'
      and article_id in (select value from json_each(${JSON.stringify(articleIds)}))
    returning article_id as articleId
  `);
  return rows.map((row) => row.articleId);
}

/**
 * バッチで訳せなかった記事の印を外し、count なら回数を 1 つ数える（docs/decisions/translation.md の
 * 4、8）。行が queued なら、giveUp（拒否）か、回数が上限に達したら untranslated にし、そうでなければ
 * 待ちに戻す。queued でない行（その場の翻訳の最中など）は、状態を変えない。印がそのバッチの行だけ
 * （同じ文で確かめる）。articleId がなければ、そのバッチの印を持つ行すべて
 *
 * @returns untranslated にした記事
 */
export async function failBatchArticles(
  db: Database,
  batchId: string,
  input: { articleId?: string; count: boolean; giveUp: boolean },
): Promise<string[]> {
  const increment = input.count ? 1 : 0;
  const rows = await db.all<{ articleId: string; status: string }>(sql`
    update article_translations set ${CLEAR_BATCH},
      batch_attempts = batch_attempts + ${increment},
      status = case
        when status = 'queued'
          and (${input.giveUp ? 1 : 0} = 1 or batch_attempts + ${increment} >= ${MAX_BATCH_ATTEMPTS})
          then 'untranslated'
        else status end
    where batch_id = ${batchId}
      ${input.articleId === undefined ? sql`` : sql`and article_id = ${input.articleId}`}
    returning article_id as articleId, status
  `);
  // 返る status は書いたあとの値。もとから untranslated だった行（その場で訳せなかった）も入るが、
  // 知らせが 1 回多くなるだけ
  return rows.filter((row) => row.status === "untranslated").map((row) => row.articleId);
}
