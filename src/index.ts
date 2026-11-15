/**
 * Worker の入口。
 *
 * Cloudflare のバインディング（env）に触れてよいのは、このファイルと
 * src/platform/cloudflare/ だけ（docs/decisions/tech-stack.md）。
 * ここでは env から Platform を組み立てて渡すだけにし、処理の中身は書かない。
 */
import { WorkerEntrypoint } from "cloudflare:workers";
import { createApp } from "./app";
import { runJob } from "./jobs";
import { type Job, jobSchema } from "./jobs/job";
import { enqueueDailyCleanUp, enqueueDueFeeds } from "./jobs/schedule";
import { createCloudflarePlatform, handleQueueBatch } from "./platform/cloudflare";

/**
 * キューの封筒の中の仕事を 1 つ動かす入口（docs/decisions/jobs.md の 2）。キューの受け手が
 * ctx.exports で呼び、呼ぶたびに別の実行になる（D1 のクエリと外への取得の上限を、仕事ごとに持つ）。
 *
 * HTTP からは呼べないが、同じアカウントの Worker からは Service binding で呼べるので、
 * 受け取った仕事は確かめ直す。
 */
export class JobRunner extends WorkerEntrypoint<Env> {
  async run(job: Job): Promise<void> {
    await runJob(createCloudflarePlatform(this.env), jobSchema.parse(job));
  }
}

export default {
  fetch(request, env, ctx) {
    return createApp(createCloudflarePlatform(env)).fetch(request, env, ctx);
  },

  async scheduled(controller, env) {
    const platform = createCloudflarePlatform(env);
    if (await enqueueDailyCleanUp(platform, new Date(controller.scheduledTime))) {
      console.info("enqueued daily clean-up");
    }
    const count = await enqueueDueFeeds(platform);
    if (count > 0) console.info("enqueued due feeds", { count });
  },

  async queue(batch, env, ctx) {
    await handleQueueBatch(batch, ctx.exports.JobRunner, env.JOBS);
  },
} satisfies ExportedHandler<Env>;
