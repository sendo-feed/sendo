import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { type Database, getRow } from ".";
import { DB_NOW_MS } from "./clock";
import { tagHorizons, tags } from "./schema";
import { nextSeq } from "./seq";

/*
 * 人ごとのタグ（docs/decisions/tags.md の 4、6、7）。形はベル（db/bells.ts）にそろえる。
 */

/** 1 人が持てる有効なタグの数 */
export const MAX_TAGS = 100;
/** 名前と説明の長さ（前後の空白を除いたコードポイントの数） */
export const MAX_TAG_NAME_LENGTH = 64;
export const MAX_TAG_DESCRIPTION_LENGTH = 140;

/** 消したタグの行を、同期のために残しておく長さ */
export const TAG_REMOVAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** 作る文が入らなかったときに、もう一度流す回数（docs/decisions/notifications.md の 3 と同じ） */
const CREATE_ATTEMPTS = 2;

export type ActiveTag = {
  id: string;
  name: string;
  description: string;
  createdAt: Date;
};

export type TagInput = { name: string; matchKey: string; description: string };

const CONTROL_OR_LONE_SURROGATE =
  /[\p{Cc}]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

/**
 * タグの名前と説明を確かめて整える（docs/decisions/tags.md の 4）。前後の空白を除いてから測り、名前は
 * 1〜64、説明は 0〜140 コードポイント。名前が空、上限を超える、制御文字か対になっていないサロゲートを
 * 含む、のどれかなら、問題の説明を返す
 */
export function parseTagInput(input: {
  name: string;
  description?: string | undefined;
}): TagInput | string {
  const name = input.name.trim();
  const description = (input.description ?? "").trim();
  const length = (text: string) => [...text].length;
  if (length(name) === 0) return "name must not be empty";
  if (length(name) > MAX_TAG_NAME_LENGTH) {
    return `name must be at most ${MAX_TAG_NAME_LENGTH} characters`;
  }
  if (length(description) > MAX_TAG_DESCRIPTION_LENGTH) {
    return `description must be at most ${MAX_TAG_DESCRIPTION_LENGTH} characters`;
  }
  if (CONTROL_OR_LONE_SURROGATE.test(name) || CONTROL_OR_LONE_SURROGATE.test(description)) {
    return "name and description must not contain control characters";
  }
  return { name, matchKey: tagMatchKey(name), description };
}

/**
 * 照合用の名前。まとめの鍵と同じ作り方（NFKC、小文字、前後の空白を除き、空白を 1 つにそろえる。
 * docs/decisions/article-analysis.md の 11）
 */
export function tagMatchKey(name: string): string {
  return name.normalize("NFKC").toLowerCase().split(/\s+/u).filter(Boolean).join(" ");
}

/**
 * その人の有効なタグを、作った順で返す。名前を変えると変更番号が変わるので、作った時刻と ID の順にする
 * （ベルは変えられないので変更番号の順）
 */
export async function listTags(db: Database, userId: string): Promise<ActiveTag[]> {
  return db
    .select({
      id: tags.id,
      name: tags.name,
      description: tags.description,
      createdAt: tags.createdAt,
    })
    .from(tags)
    .where(and(eq(tags.userId, userId), isNull(tags.deletedAt)))
    .orderBy(asc(tags.createdAt), asc(tags.id))
    .all();
}

export type CreateTagResult =
  | { created: boolean; tag: ActiveTag }
  | "tag_limit_reached"
  | "tag_id_taken";

/**
 * タグを作る。有効なタグの数は作る文の中で数え、同じ照合用の名前の有効なタグと ID の重なりは、一意索引に
 * ぶつけて止める。入らなければ、理由を 1 つの文で読み直す。同じ照合用の名前の有効なタグがあれば、送った
 * id・説明・上限によらずそれを返す。どれにも当たらなければ（読み直す前に、そのタグが消された）、作る文を
 * もう一度だけ流す（docs/decisions/tags.md の 4、6）
 */
export async function createTag(
  db: Database,
  input: { userId: string; id: string } & TagInput,
): Promise<CreateTagResult> {
  const { userId, id, name, matchKey, description } = input;
  for (let attempt = 0; attempt < CREATE_ATTEMPTS; attempt++) {
    const inserted = await getRow<{ createdAt: number }>(
      db,
      sql`insert into ${tags} (id, user_id, name, match_key, description, created_at, seq)
      select ${id}, ${userId}, ${name}, ${matchKey}, ${description}, ${DB_NOW_MS}, ${nextSeq(tags)}
      where (select count(*) from ${tags} as counted
          where counted.user_id = ${userId} and counted.deleted_at is null) < ${MAX_TAGS}
      on conflict do nothing
      returning created_at as "createdAt"`,
    );
    if (inserted) {
      return {
        created: true,
        tag: { id, name, description, createdAt: new Date(inserted.createdAt) },
      };
    }
    const found = await getRow<{
      tagId: string | null;
      name: string | null;
      description: string | null;
      createdAt: number | null;
      full: number;
      idTaken: number;
    }>(
      db,
      sql`select existing.id as "tagId", existing.name, existing.description,
        existing.created_at as "createdAt",
        (select count(*) from ${tags} where user_id = ${userId} and deleted_at is null)
          >= ${MAX_TAGS} as "full",
        exists (select 1 from ${tags} where id = ${id}) as "idTaken"
      from (select 1)
      left join ${tags} as existing
        on existing.user_id = ${userId} and existing.deleted_at is null
        and existing.match_key = ${matchKey}`,
    );
    if (!found) throw new Error("could not read the tag back");
    if (found.tagId !== null && found.createdAt !== null) {
      return {
        created: false,
        tag: {
          id: found.tagId,
          name: found.name ?? name,
          description: found.description ?? "",
          createdAt: new Date(found.createdAt),
        },
      };
    }
    if (found.full) return "tag_limit_reached";
    if (found.idTaken) return "tag_id_taken";
  }
  throw new Error("tag was neither created nor found");
}

/**
 * その人の有効なタグの名前と説明を変え、新しい変更番号を振る。変えた照合用の名前がほかの有効なタグと
 * 同じなら変えない。確かめるのは同じ文の中で、重なって入ったものは一意索引が止める
 * （docs/decisions/tags.md の 6）
 */
export async function updateTag(
  db: Database,
  input: { userId: string; id: string } & TagInput,
): Promise<{ tag: ActiveTag } | "not_found" | "tag_name_taken"> {
  const { userId, id, name, matchKey, description } = input;
  let row: { createdAt: number } | undefined;
  try {
    row = await getRow<{ createdAt: number }>(
      db,
      sql`update ${tags} set name = ${name}, match_key = ${matchKey},
        description = ${description}, seq = ${nextSeq(tags)}
      where id = ${id} and user_id = ${userId} and deleted_at is null
        and not exists (
          select 1 from ${tags} as other
          where other.user_id = ${userId} and other.deleted_at is null
            and other.match_key = ${matchKey} and other.id != ${id}
        )
      returning created_at as "createdAt"`,
    );
  } catch (error) {
    if (isUniqueViolation(error)) return "tag_name_taken";
    throw error;
  }
  if (row) return { tag: { id, name, description, createdAt: new Date(row.createdAt) } };
  const exists = await getRow<{ found: number }>(
    db,
    sql`select 1 as found from ${tags}
    where id = ${id} and user_id = ${userId} and deleted_at is null`,
  );
  return exists ? "tag_name_taken" : "not_found";
}

/** 一意の制約に当たった例外か。drizzle はドライバの例外を cause に包む */
function isUniqueViolation(error: unknown): boolean {
  let cause = error;
  for (let depth = 0; depth < 8 && cause instanceof Error; depth++) {
    if (/UNIQUE constraint failed/.test(cause.message)) return true;
    cause = cause.cause;
  }
  return false;
}

/**
 * その人のタグを消す。消してあったタグは変えない（変更番号も振らない）。
 *
 * @returns 消したら removed、消してあったら already_removed、その人のタグがなければ not_found
 */
export async function removeTag(
  db: Database,
  input: { userId: string; id: string; now: Date },
): Promise<"removed" | "already_removed" | "not_found"> {
  const row = await getRow<{ removed: number }>(
    db,
    sql`with target as materialized (
      select id, deleted_at is null as active from ${tags}
      where user_id = ${input.userId} and id = ${input.id}
    )
    update ${tags}
    set deleted_at = case when (select active from target)
          then ${input.now.getTime()} else deleted_at end,
        seq = case when (select active from target) then ${nextSeq(tags)} else seq end
    where id = (select id from target)
    returning (select active from target) as removed`,
  );
  if (row === undefined) return "not_found";
  return row.removed ? "removed" : "already_removed";
}

/**
 * 消してから before より前のタグの行を、物理的に消す。消す文の中で、トリガーが変更番号の下限と人ごとの
 * 回収の下限を引き上げる（migrations/0082_tags-triggers.sql）。
 *
 * @returns 消した行の数。limit と同じなら、まだ残っているかもしれない
 */
export async function collectRemovedTags(
  db: Database,
  input: { before: Date; limit: number },
): Promise<number> {
  const rows = await db.all<{ id: string }>(sql`
    delete from ${tags}
    where rowid in (
      select rowid from ${tags}
      where deleted_at < ${input.before.getTime()}
      order by deleted_at limit ${input.limit}
    )
    returning id
  `);
  return rows.length;
}

/** その人のタグの消した印の行を、どこまで回収したか。回収したことがなければ 0 */
export async function readTagHorizon(db: Database, userId: string): Promise<number> {
  const row = await db
    .select({ seq: tagHorizons.seq })
    .from(tagHorizons)
    .where(eq(tagHorizons.userId, userId))
    .get();
  return row?.seq ?? 0;
}
