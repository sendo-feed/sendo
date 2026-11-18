import { and, eq, isNull, or, sql } from "drizzle-orm";
import type { Database } from "../../db";
import { inboxConditions, inboxOrder, inboxPage, inboxSelection } from "../../db/inbox";
import { articleSearchDocuments, articles, userArticles } from "../../db/schema";
import type { ArticleSearch, SearchInput } from "..";

const DAILY_INDEX_LIMIT = 1500;

const revision = sql`case
  when p.status = 'extracted' and p.html is not null then 'page:' || p.attempted_at
  when a.content_key is not null then 'feed:' || a.content_key
  else 'metadata'
end`;

export function createSqliteArticleSearch(db: Database): ArticleSearch {
  return {
    async pending(limit) {
      const state = await db.get<{ after: string | null; done: number; writes: number }>(sql`
        select backfill_after as "after", backfill_done as done,
          case when day = unixepoch() / 86400 then writes else 0 end as writes
        from article_search_state where id = 1
      `);
      if (!state || state.writes >= DAILY_INDEX_LIMIT) return [];
      if (!state.done) {
        // 先に候補を置いてから進める。途中で落ちたら同じ範囲を再送できる。
        const rows = await db.all<{ id: string }>(sql`
          select id from articles
          where ${state.after === null ? sql`1` : sql`id > ${state.after}`}
          order by id limit ${limit}
        `);
        if (rows.length > 0) {
          await db.run(sql`
            insert into article_search_pending (article_id)
            select a.id from articles a join json_each(${JSON.stringify(rows.map((row) => row.id))}) j
              on a.id = j.value
            where not exists (select 1 from article_search_documents where article_id = a.id)
            on conflict do nothing
          `);
        }
        await db.run(sql`
          update article_search_state
          set backfill_after = ${rows.at(-1)?.id ?? state.after}, backfill_done = ${rows.length < limit ? 1 : 0}
          where id = 1 and backfill_done = 0 and backfill_after is ${state.after}
        `);
      }
      return db.all<SearchInput>(sql`
        select a.id as articleId, a.title, a.summary, a.content_key as contentKey,
          case when p.status = 'extracted' then p.html end as pageHtml, ${revision} as revision
        from article_search_pending q
        join articles a on a.id = q.article_id
        left join page_contents p on p.article_id = a.id
        where q.retry_at <= unixepoch()
        order by q.retry_at, q.queued_at desc, q.article_id limit ${limit}
      `);
    },
    async retry(input) {
      // 遅着した仕事が、先に更新された入力の再試行を遅らせないようにする。
      const unchanged = sql`exists (
        select 1 from articles a left join page_contents p on p.article_id = a.id
        where a.id = ${input.articleId} and ${revision} = ${input.revision}
      )`;
      await db.run(sql`
        delete from article_search_pending
        where article_id = ${input.articleId} and ${unchanged}
          and exists (
            select 1 from article_search_documents
            where article_id = ${input.articleId} and revision = ${input.revision}
          )
      `);
      await db.run(sql`
        update article_search_pending set retry_at = unixepoch() + 3600
        where article_id = ${input.articleId} and ${unchanged}
      `);
    },
    async store(input) {
      const stored = await db.get<{ id: number }>(sql`
        insert into article_search_documents (article_id, revision, content, bytes)
        select ${input.articleId}, ${input.revision}, ${input.content}, ${input.bytes}
        where exists (
          select 1 from articles a left join page_contents p on p.article_id = a.id
          where a.id = ${input.articleId} and ${revision} = ${input.revision}
        ) and (
          select bytes + ${input.bytes} - coalesce(
            (select bytes from article_search_documents where article_id = ${input.articleId}), 0
          ) <= limit_bytes * 0.8
          from storage_usage where id = 1
        ) and (
          select day != unixepoch() / 86400 or writes < ${DAILY_INDEX_LIMIT}
          from article_search_state where id = 1
        )
        on conflict (article_id) do update set
          revision = excluded.revision, content = excluded.content, bytes = excluded.bytes
        where article_search_documents.revision != excluded.revision
        returning id
      `);
      return stored != null;
    },
    async find(input) {
      const doc = articleSearchDocuments;
      const term = input.keyword;
      const metadata = sql`coalesce(${articles.title}, '') || char(10) || coalesce(${articles.summary}, '')`;
      const text = sql`coalesce(${doc.content}, ${metadata})`;
      const offset = sql`instr(lower(${text}), lower(${term}))`;
      const fragment = sql<string>`substr(${text}, max(1, ${offset} - 32), 160)`;
      const longEnough = [...term].length >= 3;
      const match = sql`article_search_fts match ${`"${term.replaceAll('"', '""')}"`}`;
      const found = longEnough
        ? or(
            sql`${doc.id} in (select rowid from article_search_fts where ${match})`,
            and(isNull(doc.id), sql`${offset} > 0`),
          )
        : sql`${offset} > 0`;
      const snippet = longEnough
        ? sql<string>`coalesce(
            (select snippet(article_search_fts, 0, '', '', '…', 24)
              from article_search_fts where rowid = ${doc.id} and ${match}),
            ${fragment}
          )`
        : fragment;
      const rows = await db
        .select({ ...inboxSelection, snippet })
        .from(userArticles)
        .innerJoin(articles, eq(articles.id, userArticles.articleId))
        .leftJoin(doc, eq(doc.articleId, articles.id))
        .where(and(...inboxConditions(input), found))
        .orderBy(...inboxOrder(input))
        .limit(input.limit + 1)
        .all();
      return inboxPage(rows, input);
    },
  };
}
