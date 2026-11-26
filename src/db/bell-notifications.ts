import { type SQL, sql } from "drizzle-orm";
import { type Database, getRow } from ".";
import { DB_NOW_MS } from "./clock";
import {
  articles,
  type BELL_NOTIFICATION_STATES,
  bellNotifications,
  bells,
  feeds,
  pushRegistrations,
  sessions,
  subscriptions,
  userArticles,
} from "./schema";

/*
 * ベルの判定と、通知の行（docs/decisions/notifications.md の 8〜13）。時刻はどれも、書く文の中の DB の
 * 時計（DB_NOW_MS）で決める。窓、何件目か、上限、ベルが有効かは、行を作る文の中で数えて確かめる
 * （先に数えてから書くと、同時に動く取得の仕事が、上限を超えて行を作る）。
 */

/** 同じベルの記事をまとめて数える窓の長さ */
export const BELL_WINDOW_MS = 10 * 60 * 1000;

/** 1 つの窓で 1 件ずつ送る記事の数。次の記事からはまとめる */
export const BELL_WINDOW_SINGLES = 3;

/** 1 人に送る通知の数の上限と、数える長さ（直近 1 時間） */
export const BELL_HOURLY_LIMIT = 20;
export const BELL_LIMIT_PERIOD_MS = 60 * 60 * 1000;

/** 公開日時が、当たった時刻からこれだけ前の記事には送らない */
export const STALE_ARTICLE_MS = 24 * 60 * 60 * 1000;

/** 通知の行を残す長さ。窓と上限は、これより前の行を見ない */
export const BELL_NOTIFICATION_RETENTION_MS = 24 * 60 * 60 * 1000;

export type BellNotificationState = (typeof BELL_NOTIFICATION_STATES)[number];

/** 判定で記事に当たったベル */
export type BellHit = { articleId: string; userId: string; bellId: string };

/** 作った通知の行 */
export type CreatedNotification = { id: string; userId: string; state: BellNotificationState };

/**
 * 記事を受信箱に持つ人の、ベルの付いた購読を引く（今は購読だけのベル）。次の人と記事は除く。
 *
 * - 登録した端末のない人
 * - 取り込んだ時刻（記事の行を作った時刻）が、ベルを作った時刻より前の記事
 * - 購読を作ってから、そのフィードの取得が 1 度も成功していないうちに入った記事。今回より前に
 *   取得に最後に成功した時刻（previousSuccessAt。その試行の開始時刻）が、購読を作った時刻より前なら
 *   除く。購読したばかりの初回の取得と、OPML で作った購読の初回の取得も、これに入る
 *
 * ベルが有効かは、行を作る文（insertArticleNotifications）でも確かめ直す
 */
export async function findBellHits(
  db: Database,
  input: { articleIds: readonly string[]; previousSuccessAt: Date },
): Promise<BellHit[]> {
  return db.all<BellHit>(sql`
    select inbox.article_id as "articleId", inbox.user_id as "userId", bell.id as "bellId"
    from json_each(${JSON.stringify(input.articleIds)}) as target
    join ${articles} as article on article.id = target.value
    join ${userArticles} as inbox on inbox.article_id = article.id
    join ${subscriptions} as subscription on subscription.user_id = inbox.user_id
      and subscription.feed_id = article.feed_id and subscription.deleted_at is null
    join ${bells} as bell on bell.subscription_id = subscription.id
      and bell.user_id = inbox.user_id and bell.deleted_at is null
    where article.created_at >= bell.created_at
      and subscription.created_at <= ${input.previousSuccessAt.getTime()}
      and exists (select 1 from ${pushRegistrations} as registration
        where registration.user_id = inbox.user_id)
  `);
}

/**
 * 1 件の記事について、当たったベルの通知の行を作る。1 人に 1 つ（ユーザーと記事の一意索引）。
 *
 * 同じ文の中で、ベルが有効かを確かめ、窓、何件目か、上限を数えて状態を決める。
 * - 窓：同じベルに、始まり > 今 − 10 分 の窓があれば入れ、なければ今を始まりに開く
 * - その窓の記事の行（上限で送らなかったものも）が 3 つあれば bundled（4 件目から）
 * - そうでなければ、その人の sent の行（記事の行とまとめの行）のうち、作った時刻 > 今 − 1 時間 の
 *   ものが 20 あれば limited、なければ sent
 * - 公開日時が、今から 1 日以上前の記事には作らない。publishedAt が null（フィードに日付がなかった）
 *   なら、取り込んだ時刻を公開日時とみなす
 *
 * 同じ文で入れた行どうしは互いを数えられないので、記事ごとに文を分けて呼ぶ。同じ記事の同じ人の
 * 行がもうあれば作らない（やり直した取得の仕事は、送る仕事を積み直さない）
 *
 * @returns 作った行
 */
export async function insertArticleNotifications(
  db: Database,
  input: {
    articleId: string;
    publishedAt: Date | null;
    hits: readonly { userId: string; bellId: string }[];
  },
): Promise<CreatedNotification[]> {
  const targets = input.hits.map((hit) => ({ ...hit, id: crypto.randomUUID() }));
  return db.all<CreatedNotification>(sql`
    insert into ${bellNotifications}
      (id, user_id, bell_id, article_id, window_start, created_at, state)
    select hit.id, hit.user_id, hit.bell_id, article.id,
      coalesce(hit.window_start, ${DB_NOW_MS}), ${DB_NOW_MS},
      case
        when hit.window_start is not null and (
          select count(*) from ${bellNotifications} as counted
          where counted.bell_id = hit.bell_id and counted.article_id is not null
            and counted.window_start = hit.window_start
        ) >= ${BELL_WINDOW_SINGLES} then 'bundled'
        when (${sentInLastHour(sql`hit.user_id`)}) >= ${BELL_HOURLY_LIMIT} then 'limited'
        else 'sent'
      end
    from (
      select target.value ->> '$.id' as id, bell.user_id, bell.id as bell_id,
        (select max(open.window_start) from ${bellNotifications} as open
          where open.bell_id = bell.id and open.article_id is not null
            and open.window_start > ${DB_NOW_MS} - ${BELL_WINDOW_MS}) as window_start
      from json_each(${JSON.stringify(targets)}) as target
      join ${bells} as bell on bell.id = target.value ->> '$.bellId'
        and bell.user_id = target.value ->> '$.userId' and bell.deleted_at is null
    ) as hit
    join ${articles} as article on article.id = ${input.articleId}
    where coalesce(${input.publishedAt?.getTime() ?? null}, article.created_at)
      > ${DB_NOW_MS} - ${STALE_ARTICLE_MS}
    on conflict do nothing
    returning id, user_id as "userId", state
  `);
}

/** その人の sent の行のうち、作った時刻が直近 1 時間のものの数（SQL の式） */
function sentInLastHour(userId: SQL) {
  return sql`select count(*) from ${bellNotifications} as counted
    where counted.user_id = ${userId} and counted.state = 'sent'
      and counted.created_at > ${DB_NOW_MS} - ${BELL_LIMIT_PERIOD_MS}`;
}

/** 送る通知と、送り先の端末 */
export type PushDelivery = {
  userId: string;
  bellId: string;
  /** 記事の行なら、その記事。まとめの行は null */
  article: { id: string; title: string | null; summary: string | null } | null;
  windowStart: Date;
  registration: { endpoint: string; p256dh: string; auth: string };
  /** フィード名の候補（購読の表示名、フィードの名前、フィードの URL） */
  feed: { displayName: string | null; title: string | null; url: string };
};

/**
 * 送る仕事の通知の行と端末を読む。次のときは undefined（送らない）。
 * - 端末の登録の行がもうない（登録の解除、ログアウト、置き換え、404 ／ 410 で消した）か、その
 *   セッションの期限が切れた（期限の比べ方は sessions.ts の authenticateSession と同じ）
 * - 通知の行がもうないか、sent でない
 * - ベルが外された（購読をやめたときも、トリガーがベルを外す）
 */
export async function readPushDelivery(
  db: Database,
  input: { notificationId: string; registrationId: string; now: Date },
): Promise<PushDelivery | undefined> {
  const row = await getRow<{
    userId: string;
    bellId: string;
    articleId: string | null;
    articleTitle: string | null;
    articleSummary: string | null;
    windowStart: number;
    endpoint: string;
    p256dh: string;
    auth: string;
    displayName: string | null;
    feedTitle: string | null;
    feedUrl: string;
  }>(
    db,
    sql`select notification.user_id as "userId", notification.bell_id as "bellId",
      notification.article_id as "articleId", article.title as "articleTitle",
      article.summary as "articleSummary", notification.window_start as "windowStart",
      registration.endpoint, registration.p256dh, registration.auth,
      subscription.display_name as "displayName", feed.title as "feedTitle", feed.url as "feedUrl"
    from ${bellNotifications} as notification
    left join ${articles} as article on article.id = notification.article_id
    join ${pushRegistrations} as registration on registration.id = ${input.registrationId}
      and registration.user_id = notification.user_id
    join ${sessions} as session on session.id = registration.session_id
      and session.expires_at > ${input.now.getTime()}
    join ${bells} as bell on bell.id = notification.bell_id and bell.deleted_at is null
    join ${subscriptions} as subscription on subscription.id = bell.subscription_id
    join ${feeds} as feed on feed.id = subscription.feed_id
    where notification.id = ${input.notificationId} and notification.state = 'sent'`,
  );
  if (row === undefined) return undefined;
  return {
    userId: row.userId,
    bellId: row.bellId,
    article:
      row.articleId === null
        ? null
        : { id: row.articleId, title: row.articleTitle, summary: row.articleSummary },
    windowStart: new Date(row.windowStart),
    registration: { endpoint: row.endpoint, p256dh: row.p256dh, auth: row.auth },
    feed: { displayName: row.displayName, title: row.feedTitle, url: row.feedUrl },
  };
}
