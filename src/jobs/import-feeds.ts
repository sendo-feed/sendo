import { findFeedIdsByUrls, insertFeeds } from "../db/feeds";
import { ensureFolders } from "../db/folders";
import { backfillInbox } from "../db/inbox";
import { assignFolderIfMissing, subscribeMany } from "../db/subscriptions";
import { toFetchableUrl, UrlNotAllowedError } from "../fetcher/url-guard";
import type { OpmlEntry } from "../opml";
import type { Platform } from "../platform";

/**
 * インポートしたフィードを、そのユーザーの購読にする。
 *
 * 1. フィード（共有）がなければ作る。新しく作ったフィードは取得を積む
 * 2. ユーザーの購読を作る。すでに購読していれば、フォルダに入っていないときだけ OPML の
 *    フォルダに入れる（ユーザーが自分で整理した結果を上書きしない）
 * 3. すでにあったフィードは、補充の済んでいない購読に最近の記事を受信箱に入れる
 *
 * 何度実行しても同じ結果になるので、途中で落ちたらキューのやり直しに任せる。フィードだけ
 * 作って取得を積めなかったものも、次の取得の時刻が「今」なので、次の定期実行で拾われる。
 * @returns 新しく購読したフィードの数
 */
export async function runImportFeeds(
  platform: Pick<Platform, "db" | "jobs" | "now">,
  input: { userId: string; entries: readonly OpmlEntry[] },
): Promise<{ subscribed: number }> {
  const { db } = platform;
  const { userId } = input;
  const now = platform.now();

  // キューの中身は外から書き換えられうるので、URL はここでも確かめる
  const valid = input.entries.flatMap((entry) => {
    try {
      return [{ ...entry, url: toFetchableUrl(entry.url).href }];
    } catch (error) {
      if (error instanceof UrlNotAllowedError) return [];
      throw error;
    }
  });
  if (valid.length === 0) return { subscribed: 0 };

  const folderIds = await ensureFolders(db, {
    userId,
    names: valid.flatMap((entry) => (entry.folder === null ? [] : [entry.folder])),
    now,
  });
  const createdFeeds = new Set(
    await insertFeeds(
      db,
      valid.map((entry) => ({
        id: crypto.randomUUID(),
        url: entry.url,
        nextFetchAt: now,
        createdAt: now,
      })),
    ),
  );
  const feedIds = await findFeedIdsByUrls(
    db,
    valid.map((entry) => entry.url),
  );

  const rows = valid.flatMap((entry) => {
    const feedId = feedIds.get(entry.url);
    if (feedId === undefined) return [];
    const folderId = entry.folder === null ? null : (folderIds.get(entry.folder) ?? null);
    return [{ feedId, folderId }];
  });
  const subscribed = new Set(await subscribeMany(db, { userId, rows, now }));

  // すでに購読していたフィードのうち、フォルダに入っていないものを OPML のフォルダに入れる
  const existingByFolder = new Map<string, string[]>();
  for (const row of rows) {
    if (row.folderId === null || subscribed.has(row.feedId)) continue;
    existingByFolder.set(row.folderId, [...(existingByFolder.get(row.folderId) ?? []), row.feedId]);
  }
  for (const [folderId, ids] of existingByFolder) {
    await assignFolderIfMissing(db, { userId, folderId, feedIds: ids });
  }

  // すでにあったフィード（ほかの人が購読している）の最近の記事を受信箱に入れる。前回の
  // インポートが途中で落ちていた場合も、補充の済んでいない購読はここで入れ直す
  const toBackfill = rows.map((row) => row.feedId).filter((feedId) => !createdFeeds.has(feedId));
  if (toBackfill.length > 0) await backfillInbox(db, { userId, feedIds: toBackfill, now });

  if (createdFeeds.size > 0) {
    await platform.jobs.enqueue(
      [...createdFeeds].map((feedId) => ({ type: "fetch-feed", feedId })),
    );
  }
  return { subscribed: subscribed.size };
}
