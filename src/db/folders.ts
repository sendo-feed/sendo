import { asc, inArray } from "drizzle-orm";
import type { Database } from ".";
import { chunked } from "./chunk";
import { type Folder, folders } from "./schema";

export async function listFolders(db: Database): Promise<Folder[]> {
  return db.select().from(folders).orderBy(asc(folders.name)).all();
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
