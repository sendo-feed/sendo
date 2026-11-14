import { z } from "zod";

/**
 * キューに流す仕事。キューの中身は外から書き換えられうるので、受け取る側で必ず検証する。
 * 種類を足すときは、ここに足して runJob（index.ts）で受ける。
 */
export const jobSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("fetch-feed"), feedId: z.string().min(1) }),
]);

export type Job = z.infer<typeof jobSchema>;
