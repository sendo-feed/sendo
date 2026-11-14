import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { truncateUtf16 } from "../lib/text";
import type { Database } from ".";
import { chunked } from "./chunk";
import { type Folder, folders, subscriptions } from "./schema";
import { nextSeq } from "./seq";

export const MAX_FOLDER_NAME_LENGTH = 200;

/** フォルダ名の空白をまとめ、長すぎれば切り詰める。中身がなければ null */
export function normalizeFolderName(value: string | undefined): string | null {
  const name = value?.replace(/\s+/g, " ").trim();
  if (!name) return null;
  return truncateUtf16(name, MAX_FOLDER_NAME_LENGTH);
}

/** そのユーザーの、消していないフォルダだけを扱う条件 */
const active = (userId: string) => and(eq(folders.userId, userId), isNull(folders.deletedAt));

/** ユーザーのフォルダ（消したものを除く、名前の順） */
export async function listFolders(db: Database, userId: string): Promise<Folder[]> {
  return db.select().from(folders).where(active(userId)).orderBy(asc(folders.name)).all();
}

/** ユーザーのフォルダ。ほかの人のものや、消したものは undefined */
export async function getFolder(
  db: Database,
  input: { userId: string; id: string },
): Promise<Folder | undefined> {
  return db
    .select()
    .from(folders)
    .where(and(active(input.userId), eq(folders.id, input.id)))
    .get();
}

export class FolderNameTakenError extends Error {
  override readonly name = "FolderNameTakenError";
}

/** 同じ名前のフォルダを持っていれば FolderNameTakenError */
export async function createFolder(
  db: Database,
  input: { userId: string; id: string; name: string; now: Date },
): Promise<Folder> {
  const created = await db
    .insert(folders)
    .values({
      id: input.id,
      userId: input.userId,
      name: input.name,
      createdAt: input.now,
      seq: nextSeq(folders),
    })
    // 対象の列は書かない。drizzle は部分一意インデックスの条件（where）を「do nothing」の
    // あとに書いてしまい、SQLite の文法の誤りになる。対象を書かなければ、どの一意制約に
    // ぶつかっても飛ばす。この表でぶつかりうるのは、消していない行の一意制約だけ
    .onConflictDoNothing()
    .returning()
    .get();
  if (!created) throw new FolderNameTakenError(input.name);
  return created;
}

/** フォルダの名前を変える。なければ undefined、同じ名前が別にあれば FolderNameTakenError */
export async function renameFolder(
  db: Database,
  input: { userId: string; id: string; name: string },
): Promise<Folder | undefined> {
  const taken = await db
    .select({ id: folders.id })
    .from(folders)
    .where(and(active(input.userId), eq(folders.name, input.name)))
    .get();
  if (taken && taken.id !== input.id) throw new FolderNameTakenError(input.name);
  try {
    return await db
      .update(folders)
      .set({ name: input.name, seq: nextSeq(folders) })
      .where(and(active(input.userId), eq(folders.id, input.id)))
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
 * フォルダを消す。フォルダは消した印を付けて残し、同期でクライアントに伝える。
 *
 * 1. フォルダに消した印を付ける
 * 2. 入っていた購読を、フォルダなしに戻す（DB の ON DELETE には頼らない）
 *
 * 購読をフォルダに入れる書き込みは、同じ文の中でフォルダが消えていないかを確かめる
 * （subscriptions.ts の activeFolderId）。1 のあとに入れようとした購読はフォルダなしになり、
 * 1 の前に入った購読は 2 で外れる。2 は、フォルダがすでに消えていても毎回行うので、1 のあとで
 * 落ちても、やり直せば掃除される。
 * @returns 消したら true、なければ false
 */
export async function deleteFolder(
  db: Database,
  input: { userId: string; id: string; now: Date },
): Promise<boolean> {
  const deleted = await db
    .update(folders)
    .set({ deletedAt: input.now, seq: nextSeq(folders) })
    .where(and(active(input.userId), eq(folders.id, input.id)))
    .returning({ id: folders.id })
    .get();
  // やめた購読も、消したフォルダを指したままにしない（あとでフォルダを物理的に消せるように）。
  // ただし番号を進めるのは、やめていない購読だけ。やめた購読の番号を進めると、同じフィードを
  // 購読し直していた場合に、今の購読より後に「消した」が届き、クライアントから消える（#25 のレビュー）
  await db
    .update(subscriptions)
    .set({
      folderId: null,
      seq: sql`case when ${subscriptions.deletedAt} is null then ${nextSeq(subscriptions)} else ${subscriptions.seq} end`,
    })
    .where(and(eq(subscriptions.userId, input.userId), eq(subscriptions.folderId, input.id)))
    .run();
  return deleted !== undefined;
}

/**
 * 名前のフォルダがなければ作り、名前から ID を引ける表を返す。
 * 同じ名前が同時に作られても、一意制約で 1 つにまとまる（冪等）。
 */
export async function ensureFolders(
  db: Database,
  input: { userId: string; names: readonly string[]; now: Date },
): Promise<Map<string, string>> {
  const names = [...new Set(input.names)];
  if (names.length === 0) return new Map();

  for (const chunk of chunked(names, folders)) {
    await db
      .insert(folders)
      .values(
        chunk.map((name) => ({
          id: crypto.randomUUID(),
          userId: input.userId,
          name,
          createdAt: input.now,
          seq: nextSeq(folders),
        })),
      )
      // 対象の列は書かない。drizzle は部分一意インデックスの条件（where）を「do nothing」の
      // あとに書いてしまい、SQLite の文法の誤りになる。対象を書かなければ、どの一意制約に
      // ぶつかっても飛ばす。この表でぶつかりうるのは、消していない行の一意制約だけ
      .onConflictDoNothing()
      .run();
  }

  const ids = new Map<string, string>();
  for (const chunk of chunked(names, null)) {
    const rows = await db
      .select({ id: folders.id, name: folders.name })
      .from(folders)
      .where(and(active(input.userId), inArray(folders.name, chunk)))
      .all();
    for (const row of rows) ids.set(row.name, row.id);
  }
  return ids;
}
