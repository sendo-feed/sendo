import { and, asc, eq, isNull, ne, notExists, type SQL, sql } from "drizzle-orm";
import type { Database } from ".";
import { subscriptions, type Workspace, workspaces } from "./schema";
import { nextSeq } from "./seq";

export const MAX_WORKSPACE_NAME_LENGTH = 200;

const active = (userId: string) => and(eq(workspaces.userId, userId), isNull(workspaces.deletedAt));

export async function listWorkspaces(db: Database, userId: string): Promise<Workspace[]> {
  return db.select().from(workspaces).where(active(userId)).orderBy(asc(workspaces.name)).all();
}

export async function getWorkspace(
  db: Database,
  input: { userId: string; id: string },
): Promise<Workspace | undefined> {
  return db
    .select()
    .from(workspaces)
    .where(and(active(input.userId), eq(workspaces.id, input.id)))
    .get();
}

export async function createWorkspace(
  db: Database,
  input: { userId: string; id: string; name: string; now: Date },
): Promise<{ created: boolean; workspace: Workspace } | "name_taken" | "id_taken"> {
  const workspace = await db
    .insert(workspaces)
    .values({
      userId: input.userId,
      id: input.id,
      name: input.name,
      createdAt: input.now,
      seq: nextSeq(workspaces),
    })
    .onConflictDoNothing({ target: workspaces.id })
    .returning()
    .get()
    .catch((error: unknown) => {
      if (
        error instanceof Error &&
        /UNIQUE constraint failed: workspaces\.user_id, workspaces\.name/i.test(
          String(error.cause ?? error),
        )
      ) {
        return "name_taken" as const;
      }
      throw error;
    });
  if (workspace && workspace !== "name_taken") return { created: true, workspace };

  const previous = await getWorkspace(db, input);
  if (previous) return { created: false, workspace: previous };

  return workspace ?? "id_taken";
}

export async function renameWorkspace(
  db: Database,
  input: { userId: string; id: string; name: string },
): Promise<Workspace | "name_taken" | "not_found"> {
  const nameTaken = db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(and(active(input.userId), eq(workspaces.name, input.name), ne(workspaces.id, input.id)));
  const workspace = await db
    .update(workspaces)
    .set({
      name: input.name,
      seq: sql`case when ${workspaces.name} = ${input.name} then ${workspaces.seq}
                    else ${nextSeq(workspaces)} end`,
    })
    .where(and(active(input.userId), eq(workspaces.id, input.id), notExists(nameTaken)))
    .returning()
    .get();
  if (workspace) return workspace;
  return (await getWorkspace(db, input)) ? "name_taken" : "not_found";
}

export async function deleteWorkspace(
  db: Database,
  input: { userId: string; id: string; now: Date },
): Promise<"deleted" | "not_empty" | "not_found"> {
  const hasSubscriptions = db
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.userId, input.userId),
        eq(subscriptions.workspaceId, input.id),
        isNull(subscriptions.deletedAt),
      ),
    );
  const deleted = await db
    .update(workspaces)
    .set({ deletedAt: input.now, seq: nextSeq(workspaces) })
    .where(and(active(input.userId), eq(workspaces.id, input.id), notExists(hasSubscriptions)))
    .returning({ id: workspaces.id })
    .get();
  if (deleted) return "deleted";

  const workspace = await db
    .select({ deletedAt: workspaces.deletedAt })
    .from(workspaces)
    .where(and(eq(workspaces.userId, input.userId), eq(workspaces.id, input.id)))
    .get();
  if (!workspace) return "not_found";
  return workspace.deletedAt === null ? "not_empty" : "deleted";
}

/** 書き込みと同じ文で、指定されたワークスペースの所有者と削除の有無を確かめる。 */
export function activeWorkspaceId(userId: string, id: string): SQL {
  return sql`(select ${workspaces.id} from ${workspaces}
    where ${workspaces.id} = ${id}
      and ${workspaces.userId} = ${userId}
      and ${workspaces.deletedAt} is null)`;
}

export class WorkspaceNotFoundError extends Error {}

/** 取得を始める前にも入力を確かめる。書き込みでは activeWorkspaceId で確認し直す。 */
export async function requireWorkspace(db: Database, userId: string, id: string): Promise<void> {
  if (!(await getWorkspace(db, { userId, id }))) {
    throw new WorkspaceNotFoundError("workspace does not exist");
  }
}
