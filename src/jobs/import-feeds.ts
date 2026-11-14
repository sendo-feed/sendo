import { assignFolderIfMissing, insertFeeds } from "../db/feeds";
import { ensureFolders } from "../db/folders";
import { toFetchableUrl, UrlNotAllowedError } from "../fetcher/url-guard";
import type { OpmlEntry } from "../opml";
import type { Platform } from "../platform";

/**
 * インポートしたフィードを登録し、新しく入ったものの取得をキューに積む。
 *
 * すでに購読しているフィードは、フォルダに入っていなければ OPML のフォルダに入れる。
 * フォルダに入っていれば変えない（ユーザーが自分で整理した結果を上書きしない）。何度実行しても
 * 同じ結果になるので、途中で落ちたらキューのやり直しに任せる。登録だけ済んで取得を
 * 積めなかったフィードも、次の取得の時刻が「今」なので、次の定期実行で拾われる。
 */
export async function runImportFeeds(
  platform: Pick<Platform, "db" | "jobs" | "now">,
  entries: readonly OpmlEntry[],
): Promise<{ created: number }> {
  const now = platform.now();

  // キューの中身は外から書き換えられうるので、URL はここでも確かめる
  const valid = entries.flatMap((entry) => {
    try {
      return [{ ...entry, url: toFetchableUrl(entry.url).href }];
    } catch (error) {
      if (error instanceof UrlNotAllowedError) return [];
      throw error;
    }
  });
  if (valid.length === 0) return { created: 0 };

  const folderIds = await ensureFolders(platform.db, {
    names: valid.flatMap((entry) => (entry.folder === null ? [] : [entry.folder])),
    now,
  });
  const rows = valid.map((entry) => ({
    id: crypto.randomUUID(),
    url: entry.url,
    folderId: entry.folder === null ? null : (folderIds.get(entry.folder) ?? null),
    nextFetchAt: now,
    createdAt: now,
  }));
  const created = await insertFeeds(platform.db, rows);

  // すでにあったフィードのうち、フォルダに入っていないものを OPML のフォルダに入れる
  const createdIds = new Set(created);
  const existingByFolder = new Map<string, string[]>();
  for (const row of rows) {
    if (row.folderId === null || createdIds.has(row.id)) continue;
    existingByFolder.set(row.folderId, [...(existingByFolder.get(row.folderId) ?? []), row.url]);
  }
  for (const [folderId, urls] of existingByFolder) {
    await assignFolderIfMissing(platform.db, { folderId, urls });
  }

  if (created.length > 0) {
    await platform.jobs.enqueue(created.map((feedId) => ({ type: "fetch-feed", feedId })));
  }
  return { created: created.length };
}
