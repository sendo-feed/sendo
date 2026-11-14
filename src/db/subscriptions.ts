import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { Database } from ".";
import { chunked } from "./chunk";
import {
  type Feed,
  feeds,
  folders,
  type Subscription,
  subscriptions,
  userArticles,
} from "./schema";
import { nextSeq, recordSeqFloor } from "./seq";

/** 購読と、そのフィード（共有）と、入っているフォルダの名前 */
export type SubscriptionWithFeed = Subscription & { feed: Feed; folderName: string | null };

/** そのユーザーの、やめていない購読だけを扱う条件 */
const active = (userId: string) =>
  and(eq(subscriptions.userId, userId), isNull(subscriptions.deletedAt));

/** ユーザーの購読（やめたものを除く、購読した順） */
export async function listSubscriptions(
  db: Database,
  userId: string,
): Promise<SubscriptionWithFeed[]> {
  const rows = await db
    .select({ subscription: subscriptions, feed: feeds, folderName: folders.name })
    .from(subscriptions)
    .innerJoin(feeds, eq(subscriptions.feedId, feeds.id))
    .leftJoin(folders, eq(subscriptions.folderId, folders.id))
    .where(active(userId))
    .orderBy(asc(subscriptions.createdAt), asc(subscriptions.id))
    .all();
  return rows.map((row) => ({ ...row.subscription, feed: row.feed, folderName: row.folderName }));
}

/** ユーザーがそのフィードを購読していれば、その購読 */
export async function getSubscription(
  db: Database,
  input: { userId: string; feedId: string },
): Promise<SubscriptionWithFeed | undefined> {
  const row = await db
    .select({ subscription: subscriptions, feed: feeds, folderName: folders.name })
    .from(subscriptions)
    .innerJoin(feeds, eq(subscriptions.feedId, feeds.id))
    .leftJoin(folders, eq(subscriptions.folderId, folders.id))
    .where(and(active(input.userId), eq(subscriptions.feedId, input.feedId)))
    .get();
  return row && { ...row.subscription, feed: row.feed, folderName: row.folderName };
}

/**
 * フィードをまとめて購読する。すでに購読しているものは飛ばし、フォルダも変えない。
 * @returns 新しく購読したフィードの ID
 */
export async function subscribeMany(
  db: Database,
  input: {
    userId: string;
    rows: readonly { feedId: string; folderId: string | null }[];
    now: Date;
  },
): Promise<string[]> {
  const created: string[] = [];
  for (const chunk of chunked(input.rows, subscriptions)) {
    const result = await db
      .insert(subscriptions)
      .values(
        chunk.map((row) => ({
          id: crypto.randomUUID(),
          userId: input.userId,
          feedId: row.feedId,
          folderId: row.folderId,
          createdAt: input.now,
          seq: nextSeq(subscriptions),
        })),
      )
      // 対象の列は書かない。drizzle は部分一意インデックスの条件（where）を「do nothing」の
      // あとに書いてしまい、SQLite の文法の誤りになる。対象を書かなければ、どの一意制約に
      // ぶつかっても飛ばす。この表でぶつかりうるのは、消していない行の一意制約だけ
      .onConflictDoNothing()
      .returning({ feedId: subscriptions.feedId })
      .all();
    created.push(...result.map((row) => row.feedId));
  }
  return created;
}

/** 購読のフォルダを変える。null ならフォルダなし。購読していなければ undefined */
export async function setSubscriptionFolder(
  db: Database,
  input: { userId: string; feedId: string; folderId: string | null },
): Promise<Subscription | undefined> {
  return db
    .update(subscriptions)
    .set({ folderId: input.folderId, seq: nextSeq(subscriptions) })
    .where(and(active(input.userId), eq(subscriptions.feedId, input.feedId)))
    .returning()
    .get();
}

/**
 * フォルダに入っていない購読だけを、フォルダに入れる。すでにフォルダがあれば変えない
 * （ユーザーが自分で整理した結果を上書きしないため）。
 */
export async function assignFolderIfMissing(
  db: Database,
  input: { userId: string; folderId: string; feedIds: readonly string[] },
): Promise<void> {
  for (const chunk of chunked(input.feedIds, null)) {
    await db
      .update(subscriptions)
      .set({ folderId: input.folderId, seq: nextSeq(subscriptions) })
      .where(
        and(
          active(input.userId),
          inArray(subscriptions.feedId, chunk),
          isNull(subscriptions.folderId),
        ),
      )
      .run();
  }
}

/**
 * 購読をやめる（docs/decisions/sync.md）。
 *
 * 1. 購読に消した印を付ける（行は残し、同期でクライアントに伝える）
 * 2. 受信箱の変更番号の下限を記録する（最大の番号の行を消しても、その番号を二度と使わない）
 * 3. そのフィードの記事を、スターを付けたものを除いて受信箱から消す
 *
 * 2 と 3 は、購読が残っていなければ毎回行う（何度行っても同じ結果になる）。1 のあとで落ちても、
 * やり直したときに受信箱が掃除される。
 * @returns やめたら true、購読していなければ false
 */
export async function unsubscribe(
  db: Database,
  input: { userId: string; feedId: string; now: Date },
): Promise<boolean> {
  const ended = await db
    .update(subscriptions)
    .set({ deletedAt: input.now, seq: nextSeq(subscriptions) })
    .where(and(active(input.userId), eq(subscriptions.feedId, input.feedId)))
    .returning({ id: subscriptions.id })
    .get();

  await recordSeqFloor(db, userArticles);
  await db
    .delete(userArticles)
    .where(
      and(
        eq(userArticles.userId, input.userId),
        eq(userArticles.feedId, input.feedId),
        isNull(userArticles.starredAt),
      ),
    )
    .run();
  return ended !== undefined;
}
