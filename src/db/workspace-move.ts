import { and, asc, count, eq, gt, inArray, isNull, type SQL, sql } from "drizzle-orm";
import { type Database, getRow } from ".";
import { MAX_BOUND_PARAMETERS, RESERVED_PARAMETERS } from "./chunk";
import { feeds, folders, subscriptions, workspaces } from "./schema";
import { nextSeq } from "./seq";

export const MAX_WORKSPACE_MOVE_IDS = MAX_BOUND_PARAMETERS - RESERVED_PARAMETERS;

type MoveScope = {
  userId: string;
  fromWorkspaceId: string;
  toWorkspaceId: string;
  folderIds: readonly string[];
};

type MoveError = "workspace_not_found" | "folder_not_found";

function moveConditions(db: Database, scope: MoveScope) {
  const { userId, fromWorkspaceId, toWorkspaceId } = scope;
  const folderIds = [...new Set(scope.folderIds)];
  // フォルダ ID は有効性と所属の確認に使う。JSON にまとめて、購読 ID を含めても変数の上限を守る。
  const folderValues = sql`(select value from json_each(${JSON.stringify(folderIds)}))`;
  const activeFolderCount = db
    .select({ count: count() })
    .from(folders)
    .where(
      and(eq(folders.userId, userId), isNull(folders.deletedAt), inArray(folders.id, folderValues)),
    );

  const activeWorkspaceCount = db
    .select({ count: count() })
    .from(workspaces)
    .where(
      and(
        eq(workspaces.userId, userId),
        isNull(workspaces.deletedAt),
        inArray(workspaces.id, [fromWorkspaceId, toWorkspaceId]),
      ),
    );

  const validWorkspaces = sql`(${activeWorkspaceCount}) = 2`;
  const validFolders = sql`(${activeFolderCount}) = ${folderIds.length}`;
  const matches = and(
    eq(subscriptions.userId, userId),
    isNull(subscriptions.deletedAt),
    eq(subscriptions.workspaceId, fromWorkspaceId),
    inArray(subscriptions.folderId, folderValues),
    validWorkspaces,
    validFolders,
  );
  return { matches, validWorkspaces, validFolders };
}

async function moveScopeError(
  db: Database,
  conditions: { validWorkspaces: SQL; validFolders: SQL },
): Promise<MoveError | null> {
  const row = await getRow<{ error: MoveError | null }>(
    db,
    sql`select case
      when not (${conditions.validWorkspaces}) then 'workspace_not_found'
      when not (${conditions.validFolders}) then 'folder_not_found'
    end as error`,
  );
  return row?.error ?? null;
}

export async function previewWorkspaceMove(
  db: Database,
  input: MoveScope & { cursor?: string | undefined },
) {
  const conditions = moveConditions(db, input);
  const error = await moveScopeError(db, conditions);
  if (error) return error;

  const rows = await db
    .select({
      subscriptionId: subscriptions.id,
      feedId: subscriptions.feedId,
      folderId: folders.id,
      title: sql<string>`coalesce(${subscriptions.displayName}, ${feeds.title}, ${feeds.url})`,
    })
    .from(subscriptions)
    .innerJoin(feeds, eq(feeds.id, subscriptions.feedId))
    .innerJoin(folders, eq(folders.id, subscriptions.folderId))
    .where(
      and(
        conditions.matches,
        input.cursor === undefined ? undefined : gt(subscriptions.id, input.cursor),
      ),
    )
    .orderBy(asc(subscriptions.id))
    .limit(MAX_WORKSPACE_MOVE_IDS + 1)
    .all();
  if (rows.length === 0) {
    const error = await moveScopeError(db, conditions);
    if (error) return error;
  }
  return {
    subscriptions: rows.slice(0, MAX_WORKSPACE_MOVE_IDS),
    nextCursor:
      rows.length > MAX_WORKSPACE_MOVE_IDS
        ? (rows[MAX_WORKSPACE_MOVE_IDS - 1]?.subscriptionId ?? null)
        : null,
  };
}

export async function moveWorkspaceSubscriptions(
  db: Database,
  input: MoveScope & { subscriptionIds: readonly string[] },
): Promise<number | MoveError> {
  const conditions = moveConditions(db, input);
  const error = await moveScopeError(db, conditions);
  if (error) return error;

  // 渡された ID から主キーで行を探す。移動元の購読を全部走査せず、確認された行だけを調べる。
  const selectedRows = sql`(
    select s.rowid
    from json_each(${JSON.stringify(input.subscriptionIds)}) as j
    cross join ${subscriptions} as s on s.id = j.value
    where s.user_id = ${input.userId}
  )`;

  // 事前確認のあとに削除や移動が入っても、書き込む文で有効性と所属を確かめ直す。
  const rows = await db
    .update(subscriptions)
    .set({ workspaceId: input.toWorkspaceId, seq: nextSeq(subscriptions) })
    .where(and(conditions.matches, inArray(sql`rowid`, selectedRows)))
    .returning({ id: subscriptions.id })
    .all();
  if (rows.length > 0) return rows.length;
  return (await moveScopeError(db, conditions)) ?? 0;
}
