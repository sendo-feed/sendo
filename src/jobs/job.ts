import { z } from "zod";
import { MAX_FOLDER_NAME_LENGTH, MAX_URL_LENGTH } from "../opml";

/**
 * インポートを 1 つのジョブで処理する件数。D1 のクエリの回数の上限（無料プランで 1 回の実行に 50 回）
 * と、Queues のメッセージの大きさの上限（128KB）に、余裕を持って収まる数にする
 */
export const IMPORT_CHUNK_SIZE = 25;

/**
 * キューに流す仕事。キューの中身は外から書き換えられうるので、受け取る側で必ず検証する。
 * 種類を足すときは、ここに足して runJob（index.ts）で受ける。
 */
export const jobSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("fetch-feed"), feedId: z.string().min(1) }),
  z.object({
    type: z.literal("import-feeds"),
    feeds: z
      .array(
        z.object({
          url: z.string().min(1).max(MAX_URL_LENGTH),
          folder: z.string().min(1).max(MAX_FOLDER_NAME_LENGTH).nullable(),
        }),
      )
      .min(1)
      .max(IMPORT_CHUNK_SIZE),
  }),
]);

export type Job = z.infer<typeof jobSchema>;
