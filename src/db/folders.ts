import { asc, eq, inArray } from "drizzle-orm";
import { truncateUtf16 } from "../lib/text";
import type { Database } from ".";
import { chunked } from "./chunk";
import { type Folder, feeds, folders } from "./schema";

export const MAX_FOLDER_NAME_LENGTH = 200;

/** フォルダ名の空白をまとめ、長すぎれば切り詰める。中身がなければ null */
export function normalizeFolderName(value: string | undefined): string | null {
  const name = value?.replace(/\s+/g, " ").trim();
  if (!name) return null;
  return truncateUtf16(name, MAX_FOLDER_NAME_LENGTH);
}

export async function listFolders(db: Database): Promise<Folder[]> {
  return db.select().from(folders).orderBy(asc(folders.name)).all();
}

export async function getFolder(db: Database, id: string): Promise<Folder | undefined> {
  return db.select().from(folders).where(eq(folders.id, id)).get();
}

export class FolderNameTakenError extends Error {
  override readonly name = "FolderNameTakenError";
}

/** フォルダを作る。同じ名前があれば FolderNameTakenError */
export async function createFolder(
  db: Database,
  input: { id: string; name: string; now: Date },
): Promise<Folder> {
  const created = await db
    .insert(folders)
    .values({ id: input.id, name: input.name, createdAt: input.now })
    .onConflictDoNothing({ target: folders.name })
    .returning()
    .get();
  if (!created) throw new FolderNameTakenError(input.name);
  return created;
}

/** フォルダの名前を変える。なければ undefined、同じ名前が別にあれば FolderNameTakenError */
export async function renameFolder(
  db: Database,
  input: { id: string; name: string },
): Promise<Folder | undefined> {
  const taken = await db
    .select({ id: folders.id })
    .from(folders)
    .where(eq(folders.name, input.name))
    .get();
  if (taken && taken.id !== input.id) throw new FolderNameTakenError(input.name);
  try {
    return await db
      .update(folders)
      .set({ name: input.name })
      .where(eq(folders.id, input.id))
      .returning()
      .get();
  } catch (error) {
    // 確かめた直後に同じ名前が作られた場合
    if (error instanceof Error && /UNIQUE constraint failed/i.test(String(error.cause ?? error))) {
      throw new FolderNameTakenError(input.name);
    }
    throw error;
  }
}

/**
 * フォルダを消す。入っていたフィードは、先にフォルダなしに戻す（DB の ON DELETE には頼らない。
 * schema.ts の feeds.folderId を参照）。この順なら、途中で落ちてもやり直せば正しい状態になる。
 * @returns 消したら true、なければ false
 */
export async function deleteFolder(db: Database, id: string): Promise<boolean> {
  await db.update(feeds).set({ folderId: null }).where(eq(feeds.folderId, id)).run();
  const deleted = await db
    .delete(folders)
    .where(eq(folders.id, id))
    .returning({ id: folders.id })
    .get();
  return deleted !== undefined;
}

/**
 * 名前のフォルダがなければ作り、名前から ID を引ける表を返す。
 * 同じ名前が同時に作られても、名前の一意制約で 1 つにまとまる（冪等）。
 */
export async function ensureFolders(
  db: Database,
  input: { names: readonly string[]; now: Date },
): Promise<Map<string, string>> {
  const names = [...new Set(input.names)];
  if (names.length === 0) return new Map();

  for (const chunk of chunked(names, folders)) {
    await db
      .insert(folders)
      .values(chunk.map((name) => ({ id: crypto.randomUUID(), name, createdAt: input.now })))
      .onConflictDoNothing({ target: folders.name })
      .run();
  }

  const ids = new Map<string, string>();
  for (const chunk of chunked(names, null)) {
    const rows = await db
      .select({ id: folders.id, name: folders.name })
      .from(folders)
      .where(inArray(folders.name, chunk))
      .all();
    for (const row of rows) ids.set(row.name, row.id);
  }
  return ids;
}
