import { and, eq, sql } from "drizzle-orm";
import type { Database } from ".";
import { DB_NOW_MS } from "./clock";
import { pushRegistrations, sessions } from "./schema";

/*
 * 端末の Web Push の登録（docs/decisions/web-push.md の 4）。ブラウザのセッションに結ぶ。
 */

/** 確かめた登録（notify/registration.ts の parsePushRegistration が作る） */
export type PushRegistrationKeys = { endpoint: string; p256dh: string; auth: string };

/**
 * そのセッションの登録を置く。同じセッションに同じエンドポイントと鍵があれば、何も変えない。
 * エンドポイントか鍵が違えば、新しい ID の行を入れ、同じ文の中で、同じセッションの行と同じ
 * エンドポイントの行（ほかの人の行も）を消す（INSERT OR REPLACE が一意索引にぶつかった行を消す）。
 *
 * 送る仕事は登録の行の ID を持つ。置き換えた登録に同じ ID を使うと、古いエンドポイントへの仕事が
 * 410 を受けて新しい登録を消してしまう。同じ登録の送り直しで行を変えないのは、起動のたびに送り
 * 直しても、送っている途中の仕事を空振りさせないため。
 *
 * セッションがまだあり、期限が切れていないことも同じ文の中で確かめる（認証のあとにログアウトしたり、
 * 期限が切れたりしたら、何も入れない。期限の比べ方は sessions.ts の authenticateSession と同じ）
 */
export async function putPushRegistration(
  db: Database,
  input: { userId: string; sessionId: string; now: Date } & PushRegistrationKeys,
): Promise<void> {
  const { userId, sessionId, now, endpoint, p256dh, auth } = input;
  await db.run(sql`insert or replace into ${pushRegistrations}
    (id, user_id, session_id, endpoint, p256dh, auth, created_at)
    select ${crypto.randomUUID()}, ${sessions.userId}, ${sessions.id}, ${endpoint}, ${p256dh},
      ${auth}, ${DB_NOW_MS}
    from ${sessions}
    where ${sessions.id} = ${sessionId} and ${sessions.userId} = ${userId}
      and ${sessions.expiresAt} > ${now.getTime()}
      and not exists (select 1 from ${pushRegistrations} as same
        where same.session_id = ${sessionId} and same.endpoint = ${endpoint}
          and same.p256dh = ${p256dh} and same.auth = ${auth})`);
}

/** そのセッションの登録を外す。なければ何もしない */
export async function deletePushRegistration(
  db: Database,
  input: { userId: string; sessionId: string },
): Promise<void> {
  await db
    .delete(pushRegistrations)
    .where(
      and(
        eq(pushRegistrations.sessionId, input.sessionId),
        eq(pushRegistrations.userId, input.userId),
      ),
    )
    .run();
}

/**
 * 期限の切れたセッションの登録を、limit 行まで消す（1 日 1 回の片付け）。切れたセッションは延ばせず、
 * もう使われないので、その端末には送らない
 *
 * @returns 消した行の数
 */
export async function collectExpiredPushRegistrations(
  db: Database,
  input: { now: Date; limit: number },
): Promise<number> {
  const rows = await db.all<{ id: string }>(sql`
    delete from ${pushRegistrations}
    where id in (
      select registration.id from ${pushRegistrations} as registration
      join ${sessions} as session on session.id = registration.session_id
      where session.expires_at <= ${input.now.getTime()}
      limit ${input.limit}
    )
    returning id
  `);
  return rows.length;
}
