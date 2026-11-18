import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import type { Database } from ".";
import { articleActivity } from "./schema";

export const ACTIVITY_BATCH_LIMIT = 50;
export const ACTIVITY_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const ACTIVITY_USER_LIMIT = 20_000;
const MAX_FUTURE_OFFSET_MS = 5 * 60 * 1000;

export type ArticleOpen = { id: string; articleId: string; occurredAt: Date };
export type ActivityCursor = { at: number; id: string };

/** 端末から届いた開封を一度だけ書く。記事へのアクセスと件数の上限は同じ文で確かめる。 */
export async function recordArticleOpens(
  db: Database,
  input: { userId: string; events: readonly ArticleOpen[]; now: Date },
): Promise<number> {
  const { userId } = input;
  const now = input.now.getTime();
  const events = [...new Map(input.events.map((event) => [event.id, event])).values()].map(
    ({ id, articleId, occurredAt }) => ({ id, articleId, at: occurredAt.getTime() }),
  );
  const recorded = await db.all<{ id: string }>(sql`
    with events as (
      select json_extract(value, '$.id') as id,
        json_extract(value, '$.articleId') as article_id,
        json_extract(value, '$.at') as occurred_at
      from json_each(${JSON.stringify(events)})
    )
    insert into article_activity
      (user_id, id, article_id, occurred_at, type, source, article_title, article_url)
    select ${userId}, e.id, e.article_id, e.occurred_at, 'article_opened', 'reader', a.title, a.url
    from events e
    join user_articles u on u.user_id = ${userId} and u.article_id = e.article_id
    join articles a on a.id = u.article_id
    where e.occurred_at between ${now - ACTIVITY_RETENTION_MS} and ${now + MAX_FUTURE_OFFSET_MS}
      and not exists (
        select 1 from article_activity h where h.user_id = ${userId} and h.id = e.id
      )
    order by e.occurred_at desc, e.id desc
    limit (
      select max(0, ${ACTIVITY_USER_LIMIT} - count(*))
      from article_activity where user_id = ${userId}
    )
    on conflict (user_id, id) do nothing
    returning id
  `);
  return recorded.length;
}

export async function listActivity(
  db: Database,
  input: {
    userId: string;
    now: Date;
    type?: "article_opened" | undefined;
    source?: "reader" | undefined;
    since?: Date | undefined;
    until?: Date | undefined;
    cursor?: ActivityCursor | undefined;
    limit: number;
  },
): Promise<{ events: (typeof articleActivity.$inferSelect)[]; next: ActivityCursor | null }> {
  const { cursor, limit, since, until, type, source } = input;
  const lowerBound = new Date(
    Math.max(input.now.getTime() - ACTIVITY_RETENTION_MS, since?.getTime() ?? 0),
  );
  const rows = await db
    .select()
    .from(articleActivity)
    .where(
      and(
        eq(articleActivity.userId, input.userId),
        gte(articleActivity.occurredAt, lowerBound),
        type === undefined ? undefined : eq(articleActivity.type, type),
        source === undefined ? undefined : eq(articleActivity.source, source),
        until === undefined ? undefined : lt(articleActivity.occurredAt, until),
        cursor
          ? sql`(${articleActivity.occurredAt}, ${articleActivity.id}) < (${cursor.at}, ${cursor.id})`
          : undefined,
      ),
    )
    .orderBy(desc(articleActivity.occurredAt), desc(articleActivity.id))
    .limit(limit + 1)
    .all();
  const events = rows.slice(0, limit);
  const last = events.at(-1);
  return {
    events,
    next: rows.length > limit && last ? { at: last.occurredAt.getTime(), id: last.id } : null,
  };
}

export async function collectExpiredArticleActivity(
  db: Database,
  input: { before: Date; limit: number },
): Promise<number> {
  const rows = await db.all<{ id: string }>(sql`
    delete from article_activity
    where rowid in (
      select rowid from article_activity where occurred_at < ${input.before.getTime()}
      order by occurred_at limit ${input.limit}
    )
    returning id
  `);
  return rows.length;
}
