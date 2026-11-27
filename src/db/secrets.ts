import { eq } from "drizzle-orm";
import { randomBase64Url } from "../lib/crypto";
import { createImageSigner, type ImageSigner } from "../lib/image-url";
import type { Database } from ".";
import { DB_NOW_MS } from "./clock";
import { appSecrets } from "./schema";

/*
 * sendo が自分で作って持つ秘密（docs/decisions/images.md の 2）。デプロイする人が入れる設定を
 * 増やさないように、初めて使うときに作って DB に置く。
 */

/** 画像の URL の署名の鍵の名前 */
export const IMAGE_SIGNING_KEY = "image_signing_key";

/** VAPID の鍵の組の名前（docs/decisions/web-push.md の 1） */
export const VAPID_KEY = "vapid_key";

/**
 * 秘密を読む。なければ create で作る。
 *
 * 「なければ入れる」を 1 つの文で行い、入れたあとで読み直す。2 つのリクエストが同時に作ろうと
 * しても、主キーで 1 つにまとまり、どちらも同じ値を読む（先に入った方の値で、もう片方が作った値は
 * 捨てる）
 */
export async function getOrCreateSecret(
  db: Database,
  name: string,
  create: () => string | Promise<string>,
): Promise<string> {
  const read = () =>
    db.select({ value: appSecrets.value }).from(appSecrets).where(eq(appSecrets.name, name)).get();

  const existing = await read();
  if (existing) return existing.value;

  await db
    .insert(appSecrets)
    .values({ name, value: await create(), createdAt: DB_NOW_MS })
    .onConflictDoNothing({ target: appSecrets.name });
  const created = await read();
  if (!created) throw new Error(`secret disappeared while creating: ${name}`);
  return created.value;
}

/**
 * 画像の URL に署名する ／ 署名を確かめる道具（docs/decisions/images.md の 2）。
 *
 * 鍵は、初めて要るときに読む。画像のない応答（サムネイルのない記事だけの一覧など）では、
 * DB を読まない。1 回のリクエストの中で使い回す
 */
export function imageSigner(db: Database): ImageSigner {
  let loading: Promise<ImageSigner> | undefined;
  const load = () => {
    loading ??= getOrCreateSecret(db, IMAGE_SIGNING_KEY, () => randomBase64Url(32)).then(
      createImageSigner,
    );
    return loading;
  };
  return {
    async toRelayUrl(url) {
      return url === null ? null : (await load()).toRelayUrl(url);
    },
    async verify(url, signature) {
      return (await load()).verify(url, signature);
    },
  };
}
