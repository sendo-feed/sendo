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
 * ベルの判定と、通知の行（docs/decisions/notifications.md の 8〜13）。通知の行は、当たった記事ごとの
 * 「通知の記事の行」と、まとめた窓ごとの「通知のまとめの行」（記事の ID が null）の 2 種類。時刻は
 * どれも、書く文の中の DB の時計（DB_NOW_MS）で決める。窓、何件目か、上限、ベルが有効か、受信箱に
 * 未読かは、行を作る文の中で数えて確かめる（先に数えてから書くと、同時に動く取得の仕事が、上限を
 * 超えて行を作る）。
 */

/** 同じベルの記事をまとめて数える窓の長さ */
export const BELL_WINDOW_MS = 10 * 60 * 1000;

/** 1 つの窓で 1 件ずつ送る記事の数。次の記事からはまとめる */
export const BELL_WINDOW_SINGLES = 3;

/** 1 人に送る通知の数の上限と、数える長さ（直近 1 時間） */
export const BELL_HOURLY_LIMIT = 20;
export const BELL_LIMIT_PERIOD_MS = 60 * 60 * 1000;

/**
 * 窓が閉じてから、まとめてよい長さ。まとめの仕事がこれより遅れて動いたら（プロセスが止まっていた
 * 間に時刻の来た仕事など）、古い話になるのでまとめない
 */
export const BELL_BUNDLE_DEADLINE_MS = 60 * 60 * 1000;

/** 公開日時が、当たった時刻からこれだけ前の記事には送らない */
export const STALE_ARTICLE_MS = 24 * 60 * 60 * 1000;

/** 通知の行を残す長さ。窓と上限は、これより前の行を見ない */
export const BELL_NOTIFICATION_RETENTION_MS = 24 * 60 * 60 * 1000;

export type BellNotificationState = (typeof BELL_NOTIFICATION_STATES)[number];

/** 判定で記事に当たったベル */
export type BellHit = { articleId: string; userId: string; bellId: string };

/**
 * 判定の候補のベル。言葉のあるベルは、記事の文字が言葉に当たったときだけ当たる（判定は
 * jobs/bell-notifications.ts）
 */
export type BellCandidate = BellHit & {
  /** 照合用の言葉。言葉のないベルは null */
  matchKey: string | null;
};

/** 作った通知の行 */
export type CreatedNotification = { id: string; userId: string; state: BellNotificationState };

/** まとめる窓（同じ人の同じベルの、同じ始まりの通知の記事の行）。windowStart はミリ秒 */
export type BellWindow = { userId: string; bellId: string; windowStart: number };

/**
 * 記事を受信箱に持つ人の、判定の候補のベルを引く。その記事の購読のベル（購読だけ、購読 AND
 * 言葉）と、言葉だけのベル。言葉はまだ当てない。次の人と記事は除く。
 *
 * - 登録した端末のない人。期限の切れたセッションの登録は数えない（日次の片付けまで行は残るが、
 *   送れない。行を作ると 1 時間の上限を使い、窓に溜めた記事を、登録し直した端末へまとめて送る）
 * - 取り込んだ時刻（記事の行を作った時刻）が、ベルを作った時刻より前の記事
 * - 購読を作ってから、そのフィードの取得が 1 度も成功していないうちに入った記事。今回より前に
 *   取得に最後に成功した時刻（previousSuccessAt。その試行の開始時刻）が、購読を作った時刻より前なら
 *   除く。購読したばかりの初回の取得と、OPML で作った購読の初回の取得も、これに入る
 *
 * ベルが有効かと、受信箱に未読かは、行を作る文（insertArticleNotifications）で確かめ直す
 */
export async function findBellCandidates(
  db: Database,
  input: { articleIds: readonly string[]; previousSuccessAt: Date },
): Promise<BellCandidate[]> {
  return db.all<BellCandidate>(sql`
    select inbox.article_id as "articleId", inbox.user_id as "userId", bell.id as "bellId",
      bell.match_key as "matchKey"
    from json_each(${JSON.stringify(input.articleIds)}) as target
    join ${articles} as article on article.id = target.value
    join ${userArticles} as inbox on inbox.article_id = article.id
    join ${subscriptions} as subscription on subscription.user_id = inbox.user_id
      and subscription.feed_id = article.feed_id and subscription.deleted_at is null
    join ${bells} as bell on bell.user_id = inbox.user_id and bell.deleted_at is null
      and (bell.subscription_id = subscription.id or bell.subscription_id is null)
    where article.created_at >= bell.created_at
      and subscription.created_at <= ${input.previousSuccessAt.getTime()}
      and exists (select 1 from ${pushRegistrations} as registration
        join ${sessions} as session on session.id = registration.session_id
          and session.expires_at > ${DB_NOW_MS}
        where registration.user_id = inbox.user_id)
  `);
}

/**
 * 1 件の記事について、当たったベルの通知の記事の行を作る。1 人に 1 つ（ユーザーと記事の一意索引）。
 *
 * 同じ文の中で、ベルが有効かを確かめ、1 人に当たった有効なベルから 1 つを選び、窓、何件目か、上限を
 * 数えて状態を決める。
 * - 選ぶ順は、購読 AND 言葉、言葉だけ、購読だけ。同じ種類なら、作ったのが古いベル（docs/decisions/
 *   notifications.md の 9）。言葉のあるベルを先に選ぶと、通知に当たった言葉が出る
 * - 窓：同じベルに、始まり > 今 − 10 分 の窓があれば入れ、なければ今を始まりに開く
 * - その窓の通知の記事の行（上限で送らなかったものも）が 3 つあれば bundled（4 件目から）
 * - そうでなければ、その人の sent の行（通知の記事の行と通知のまとめの行）のうち、作った時刻 >
 *   今 − 1 時間 のものが 20 あれば limited、なければ sent
 * - 公開日時が、今から 1 日以上前の記事には作らない。publishedAt が null（フィードに日付がなかった）
 *   なら、取り込んだ時刻を公開日時とみなす
 * - その人の受信箱にその記事が未読でなければ作らない（判定を読んだあとに、購読をやめたか読んだ。
 *   言葉だけのベルは、購読をやめても外れない）
 *
 * 同じ文で入れた行どうしは互いを数えられないので、記事ごとに文を分けて呼ぶ。同じ記事の同じ人の
 * 行がもうあれば作らない（やり直した取得の仕事は、送る仕事もまとめの仕事も積み直さない）
 *
 * @returns 作った行と、作った行がその窓で最初の bundled（窓の 4 件目）になった窓。最初かどうかは、
 *   窓にほかの bundled の行がないかで見る（1 つの文が 1 つの窓に入れる行は 1 つまで。1 人に 1 行で、
 *   ベルは 1 人のもの）
 */
export async function insertArticleNotifications(
  db: Database,
  input: {
    articleId: string;
    publishedAt: Date | null;
    hits: readonly { userId: string; bellId: string }[];
  },
): Promise<{ created: CreatedNotification[]; bundles: BellWindow[] }> {
  const targets = input.hits.map((hit) => ({ ...hit, id: crypto.randomUUID() }));
  const rows = await db.all<
    CreatedNotification & { bellId: string; windowStart: number; opensBundle: number }
  >(sql`
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
            and open.window_start > ${DB_NOW_MS} - ${BELL_WINDOW_MS}) as window_start,
        row_number() over (
          partition by bell.user_id
          order by case
              when bell.subscription_id is not null and bell.match_key is not null then 0
              when bell.subscription_id is null then 1
              else 2
            end,
            bell.created_at, bell.id
        ) as choice
      from json_each(${JSON.stringify(targets)}) as target
      join ${bells} as bell on bell.id = target.value ->> '$.bellId'
        and bell.user_id = target.value ->> '$.userId' and bell.deleted_at is null
    ) as hit
    join ${articles} as article on article.id = ${input.articleId}
    where hit.choice = 1
      and coalesce(${input.publishedAt?.getTime() ?? null}, article.created_at)
      > ${DB_NOW_MS} - ${STALE_ARTICLE_MS}
      and ${unreadInInbox(sql`hit.user_id`, sql`article.id`)}
    on conflict do nothing
    returning id, user_id as "userId", state, bell_id as "bellId", window_start as "windowStart",
      state = 'bundled' and not exists (select 1 from ${bellNotifications} as other
        where other.bell_id = ${bellNotifications}.bell_id
          and other.window_start = ${bellNotifications}.window_start
          and other.state = 'bundled' and other.id <> ${bellNotifications}.id) as "opensBundle"
  `);
  return {
    created: rows.map(({ id, userId, state }) => ({ id, userId, state })),
    bundles: rows.flatMap(({ opensBundle, userId, bellId, windowStart }) =>
      opensBundle ? [{ userId, bellId, windowStart }] : [],
    ),
  };
}

/**
 * 窓の通知のまとめの行を作る（まとめの仕事）。同じ文の中で次を確かめ、上限を数えて sent か limited
 * にする。窓のまとめの行がもうあれば作らない（部分一意索引）。窓が閉じたあとに当たった記事は、DB の
 * 時計で新しい窓に入るので、このまとめには入らない
 * - 窓が閉じてから 1 時間以内（始まり + 10 分 ≤ 今 < 始まり + 70 分）
 * - その窓に、その人の受信箱に未読である記事の bundled の行がある（言葉だけのベルは、購読をやめても
 *   外れない）
 * - ベルが有効
 *
 * @returns 作った行。作らなければ undefined
 */
export async function insertBundleNotification(
  db: Database,
  window: BellWindow,
): Promise<CreatedNotification | undefined> {
  const { userId, bellId, windowStart } = window;
  return getRow<CreatedNotification>(
    db,
    sql`insert into ${bellNotifications}
      (id, user_id, bell_id, article_id, window_start, created_at, state)
    select ${crypto.randomUUID()}, ${userId}, ${bellId}, null, ${windowStart}, ${DB_NOW_MS},
      case when (${sentInLastHour(sql`${userId}`)}) >= ${BELL_HOURLY_LIMIT} then 'limited'
        else 'sent' end
    where ${windowStart} <= ${DB_NOW_MS} - ${BELL_WINDOW_MS}
      and ${windowStart} > ${DB_NOW_MS} - ${BELL_WINDOW_MS + BELL_BUNDLE_DEADLINE_MS}
      and exists (select 1 from ${bellNotifications} as pending
        where pending.bell_id = ${bellId} and pending.user_id = ${userId}
          and pending.window_start = ${windowStart} and pending.state = 'bundled'
          and ${unreadInInbox(sql`pending.user_id`, sql`pending.article_id`)})
      and exists (select 1 from ${bells} as bell
        where bell.id = ${bellId} and bell.user_id = ${userId} and bell.deleted_at is null)
    on conflict do nothing
    returning id, user_id as "userId", state`,
  );
}

/**
 * まとめに入れた記事のうち、その人の受信箱に未読であるものを、新しい順に limit 件まで読み、その数も
 * 返す。新しさは公開日時で決め、同じなら通知の記事の行を作った順で決める
 */
export async function readBundledArticles(
  db: Database,
  input: { userId: string; bellId: string; windowStart: Date; limit: number },
): Promise<{
  count: number;
  articles: { id: string; title: string | null; summary: string | null }[];
}> {
  const rows = await db.all<{
    id: string;
    title: string | null;
    summary: string | null;
    count: number;
  }>(sql`
    select article.id, article.title, article.summary, count(*) over () as count
    from ${bellNotifications} as bundled
    join ${articles} as article on article.id = bundled.article_id
    where bundled.user_id = ${input.userId} and bundled.bell_id = ${input.bellId}
      and bundled.window_start = ${input.windowStart.getTime()} and bundled.state = 'bundled'
      and ${unreadInInbox(sql`bundled.user_id`, sql`bundled.article_id`)}
    order by article.published_at desc, bundled.created_at desc, bundled.rowid desc
    limit ${input.limit}
  `);
  return {
    count: rows[0]?.count ?? 0,
    articles: rows.map(({ id, title, summary }) => ({ id, title, summary })),
  };
}

/**
 * その人の受信箱に、その記事が未読であること（SQL の条件）。受信箱から消えた記事（購読をやめた、古い
 * 記事の片付け）と、ほかの端末で読んだ記事は知らせない（docs/decisions/notifications.md の 13、
 * web-push.md の 5）。言葉だけのベルは、購読をやめても外れないので、ベルが有効かだけでは代えられない
 */
function unreadInInbox(userId: SQL, articleId: SQL) {
  return sql`exists (select 1 from ${userArticles} as inbox
    where inbox.user_id = ${userId} and inbox.article_id = ${articleId} and inbox.read_at is null)`;
}

/**
 * その人の sent の行のうち、作った時刻が直近 1 時間のものの数（SQL の式）。行を作ったあと、送る前に
 * 購読をやめた、ベルを外した、読んだなどで送らなかった行も数える
 */
function sentInLastHour(userId: SQL) {
  return sql`select count(*) from ${bellNotifications} as counted
    where counted.user_id = ${userId} and counted.state = 'sent'
      and counted.created_at > ${DB_NOW_MS} - ${BELL_LIMIT_PERIOD_MS}`;
}

/** 送る通知と、送り先の端末 */
export type PushDelivery = {
  userId: string;
  bellId: string;
  /** 通知の記事の行なら、その記事。通知のまとめの行は null */
  article: { id: string; title: string | null; summary: string | null } | null;
  windowStart: Date;
  registration: { endpoint: string; p256dh: string; auth: string };
  /** ベルの言葉。言葉のないベルは null */
  words: string | null;
  /**
   * フィード名の候補（購読の表示名、フィードの名前、フィードの URL）。記事の行は記事のフィード、
   * まとめの行はベルの購読のフィード。言葉だけのベルのまとめは null
   */
  feed: { displayName: string | null; title: string | null; url: string } | null;
};

/**
 * 送る仕事の通知の行と端末を読む。次のときは undefined（送らない）。
 * - 端末の登録の行がもうない（登録の解除、ログアウト、置き換え、404 ／ 410 で消した）か、その
 *   セッションの期限が切れた（期限の比べ方は sessions.ts の authenticateSession と同じ）
 * - 通知の行がもうないか、sent でない
 * - ベルが外された（購読をやめたときも、トリガーがその購読のベルを外す）
 * - 通知の記事の行で、その記事がもうその人の受信箱にないか、既読（購読をやめた、ほかの端末で読んだ。
 *   言葉だけのベルは、購読をやめても外れない）
 *
 * フィード名の表示名は、その人のそのフィードの有効な購読から読む。購読をやめても受信箱に残った
 * 記事（スターを付けたもの）は、表示名がないので、フィードの名前を使う
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
    words: string | null;
    displayName: string | null;
    feedTitle: string | null;
    feedUrl: string | null;
  }>(
    db,
    sql`select notification.user_id as "userId", notification.bell_id as "bellId",
      notification.article_id as "articleId", article.title as "articleTitle",
      article.summary as "articleSummary", notification.window_start as "windowStart",
      registration.endpoint, registration.p256dh, registration.auth, bell.words,
      subscription.display_name as "displayName", feed.title as "feedTitle", feed.url as "feedUrl"
    from ${bellNotifications} as notification
    left join ${articles} as article on article.id = notification.article_id
    join ${pushRegistrations} as registration on registration.id = ${input.registrationId}
      and registration.user_id = notification.user_id
    join ${sessions} as session on session.id = registration.session_id
      and session.expires_at > ${input.now.getTime()}
    join ${bells} as bell on bell.id = notification.bell_id and bell.deleted_at is null
    left join ${subscriptions} as belled on belled.id = bell.subscription_id
    left join ${feeds} as feed on feed.id = coalesce(article.feed_id, belled.feed_id)
    left join ${subscriptions} as subscription on subscription.user_id = notification.user_id
      and subscription.feed_id = feed.id and subscription.deleted_at is null
    where notification.id = ${input.notificationId} and notification.state = 'sent'
      and (notification.article_id is null
        or ${unreadInInbox(sql`notification.user_id`, sql`notification.article_id`)})`,
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
    words: row.words,
    feed:
      row.feedUrl === null
        ? null
        : { displayName: row.displayName, title: row.feedTitle, url: row.feedUrl },
  };
}

/**
 * 作ってから 1 日たった通知の行を、limit 行まで消す（1 日 1 回の片付け）。窓と上限とまとめは、
 * 直近 70 分より前の行を見ない。行を作った時刻と同じ DB の時計で比べる
 *
 * @returns 消した行の数。limit と同じなら、まだ残っているかもしれない
 */
export async function collectOldBellNotifications(
  db: Database,
  input: { limit: number },
): Promise<number> {
  const rows = await db.all<{ id: string }>(sql`
    delete from ${bellNotifications}
    where rowid in (
      select rowid from ${bellNotifications}
      where created_at < ${DB_NOW_MS} - ${BELL_NOTIFICATION_RETENTION_MS}
      order by created_at limit ${input.limit}
    )
    returning id
  `);
  return rows.length;
}
