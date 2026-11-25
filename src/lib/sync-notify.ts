/** 利用者の通知の接続に、同期を始めるよう知らせる（docs/decisions/sync.md の 9） */
export type SyncNotifier = (userIds: readonly string[]) => Promise<void>;

/**
 * 知らせる。知らせは同期を始める合図で、欠けてもよい（クライアントは定期同期も続ける）。
 * 知らせに失敗しても、書き込みや応答は止めない。
 *
 * 知らせるのは、入口（REST API のミドルウェア、MCP のツール）と、入口を
 * 通らない取得のジョブ。db/ の書き込みの中では知らせない
 */
export async function notifySync(notify: SyncNotifier, userIds: readonly string[]): Promise<void> {
  if (userIds.length === 0) return;
  try {
    await notify(userIds);
  } catch {
    console.warn("could not notify sync updates");
  }
}
