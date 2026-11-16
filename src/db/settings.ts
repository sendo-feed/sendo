import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { Database } from ".";
import { clientSettings, settingHorizons } from "./schema";
import { nextSeq } from "./seq";

/*
 * クライアントの設定（docs/decisions/settings.md）。ユーザー × 端末の種類ごとに、名前と JSON の値の
 * 組を預かる。sendo は中身を解釈しない。
 */

/** 端末の種類。どちらとして動くかは、クライアントが決めて送る */
export const DEVICE_TYPES = ["mobile", "desktop"] as const;
export type DeviceType = (typeof DEVICE_TYPES)[number];

/** 上限（docs/decisions/settings.md の 6）。項目の数と合計は、端末の種類ごと */
export const SETTING_LIMITS = {
  /** 名前の長さ（文字） */
  nameLength: 128,
  /** 値を JSON にした大きさ（UTF-8 のバイト） */
  valueBytes: 8 * 1024,
  /** 値の入れ子の深さ */
  valueDepth: 16,
  /** 1 回のリクエストで置く ／ 消す項目の数 */
  requestItems: 100,
  /** 消していない項目の数 */
  items: 1000,
  /** 消していない項目の、名前と値のバイト数の合計 */
  totalBytes: 256 * 1024,
} as const;

/** 消した印の行を残す期間。受信箱の消した記録（retention.ts）と同じ */
export const DELETED_SETTING_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const encoder = new TextEncoder();

/** 項目の大きさ（名前と、JSON にした値のバイト数） */
export function settingSize(name: string, json: string): number {
  return encoder.encode(name).length + encoder.encode(json).length;
}

export type SettingInput = {
  name: string;
  /** JSON にした値 */
  json: string;
};

/**
 * 項目を消して、置く。何度実行しても同じ結果になる。
 *
 * - 消す：行は残し、消した印と新しい番号を付けて、値を捨てる。ない項目と、もう消してある項目には
 *   何もしない
 * - 置く：なければ作り、あれば値を替えて新しい番号を振る（消した印は外す）。今と同じ値なら
 *   何も変えない（番号も振らない）
 * - 置いたあとの項目の数か合計が上限を超えるなら、1 つも置かない（"full"）。上限は、置く文の中で
 *   確かめる（先に数えてから置くと、その間に別のリクエストが入って上限を超える）。応答も、
 *   置く文が行を書いたかどうかで決める（あとから読み直して決めると、その間のほかの端末の変更で
 *   食い違う）
 *
 * 消すのを先にするのは、同じリクエストで消した分を、上限の計算から外すため。置くのを断っても、
 * 消した分は消えたままになる
 */
export async function applySettings(
  db: Database,
  input: {
    userId: string;
    deviceType: DeviceType;
    put: readonly SettingInput[];
    remove: readonly string[];
    now: Date;
  },
): Promise<"applied" | "full"> {
  const { userId, deviceType } = input;
  const now = input.now.getTime();
  const seq = nextSeq(clientSettings);

  if (input.remove.length > 0) {
    // 名前は 1 つの変数（JSON の配列）で渡す。項目の数だけ変数を並べると、D1 の「1 文あたり
    // 100 個まで」に当たる
    await db.run(sql`
      update client_settings
      set value = null, size = 0, seq = ${seq}, updated_at = ${now}, deleted_at = ${now}
      where user_id = ${userId} and device_type = ${deviceType} and deleted_at is null
        and name in (select value from json_each(${JSON.stringify(input.remove)}))
    `);
  }
  if (input.put.length === 0) return "applied";

  // 置く項目も 1 つの変数で渡す。値は、JSON の中に JSON のまま入れ、`->` で JSON の文字列として取り出す
  const toItems = (put: readonly SettingInput[]) =>
    `[${put
      .map(
        ({ name, json }) =>
          `{"name":${JSON.stringify(name)},"size":${settingSize(name, json)},"value":${json}}`,
      )
      .join(",")}]`;

  // 今と同じ値の項目は、置かない（番号を振らず、書き込みもしない）。ここで読むのは、置かなくて
  // よい項目を外すためだけで、上限を守っているのは下の置く文。読んだあとにほかの端末が変えた
  // 項目は、そのままになる（このリクエストを先に受けたのと同じ結果）
  const unchanged = await db.all<{ name: string }>(sql`
    select s.name as name
    from json_each(${toItems(input.put)}) as j
    join client_settings as s
      on s.user_id = ${userId} and s.device_type = ${deviceType}
      and s.name = json_extract(j.value, '$.name')
    where s.deleted_at is null and s.value = (j.value -> '$.value')
  `);
  const skip = new Set(unchanged.map((row) => row.name));
  const put = input.put.filter((item) => !skip.has(item.name));
  if (put.length === 0) return "applied";

  // 上限は、この文で置かない項目（今ある、消していない項目のうち、名前が重ならないもの）と、
  // この文で置く項目を足して確かめる。超えるなら 1 行も書かないので、書いた行があるかで分かる
  const others = sql`
    from client_settings as s
    where s.user_id = ${userId} and s.device_type = ${deviceType} and s.deleted_at is null
      and s.name not in (select name from items)`;
  const written = await db.all<{ name: string }>(sql`
    with items as (
      select json_extract(j.value, '$.name') as name,
        j.value -> '$.value' as value,
        json_extract(j.value, '$.size') as size
      from json_each(${toItems(put)}) as j
    )
    insert into client_settings
      (id, user_id, device_type, name, value, size, seq, updated_at, deleted_at)
    select lower(hex(randomblob(16))), ${userId}, ${deviceType},
      items.name, items.value, items.size, ${seq}, ${now}, null
    from items
    where (select count(*) ${others}) + (select count(*) from items) <= ${SETTING_LIMITS.items}
      and (select coalesce(sum(s.size), 0) ${others}) + (select sum(size) from items)
        <= ${SETTING_LIMITS.totalBytes}
    on conflict (user_id, device_type, name) do update set
      value = excluded.value, size = excluded.size, seq = excluded.seq,
      updated_at = excluded.updated_at, deleted_at = null
    returning name
  `);
  return written.length > 0 ? "applied" : "full";
}

/** その人のその種類の、消していない項目（名前の順） */
export async function listSettings(
  db: Database,
  input: { userId: string; deviceType: DeviceType },
): Promise<{ name: string; json: string }[]> {
  const rows = await db
    .select({ name: clientSettings.name, value: clientSettings.value })
    .from(clientSettings)
    .where(
      and(
        eq(clientSettings.userId, input.userId),
        eq(clientSettings.deviceType, input.deviceType),
        isNull(clientSettings.deletedAt),
      ),
    )
    .orderBy(asc(clientSettings.name))
    .all();
  return rows.flatMap((row) => (row.value === null ? [] : [{ name: row.name, json: row.value }]));
}

/**
 * 消してから DELETED_SETTING_RETENTION_MS より前の、消した印の行を回収する準備として、人ごとの
 * 回収の下限（setting_horizons）を、その人のその行の番号の最大まで引き上げる。
 *
 * 消すより先に引き上げる（retention.ts の raiseRemovalHorizons と同じ理由）
 */
export async function raiseSettingHorizons(db: Database, input: { before: Date }): Promise<void> {
  await db.run(sql`
    insert into setting_horizons (user_id, seq)
    select user_id, max(seq) from client_settings
    where deleted_at < ${input.before.getTime()}
    group by user_id
    on conflict (user_id) do update set seq = max(setting_horizons.seq, excluded.seq)
  `);
}

/**
 * 番号がその人の回収の下限（raiseSettingHorizons）までの、消した印の行を物理的に消す。
 * 置き直した行は、印が外れて新しい番号になっているので消えない。
 *
 * @returns 消した行の数。limit と同じなら、まだ残っているかもしれない
 */
export async function collectDeletedSettings(
  db: Database,
  input: { limit: number },
): Promise<number> {
  const rows = await db.all<{ id: string }>(sql`
    delete from client_settings
    where rowid in (
      select s.rowid from client_settings as s
      where s.deleted_at is not null and s.seq <= (
        select h.seq from setting_horizons as h where h.user_id = s.user_id
      )
      limit ${input.limit}
    )
    returning id
  `);
  return rows.length;
}

/** その人の設定の消した印の行を、どこまで回収したか。回収したことがなければ 0 */
export async function readSettingHorizon(db: Database, userId: string): Promise<number> {
  const row = await db
    .select({ seq: settingHorizons.seq })
    .from(settingHorizons)
    .where(eq(settingHorizons.userId, userId))
    .get();
  return row?.seq ?? 0;
}
