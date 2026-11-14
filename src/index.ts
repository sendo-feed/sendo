/**
 * Worker の入口。
 *
 * Cloudflare のバインディング（env）に触れてよいのは、このファイルと
 * src/platform/cloudflare/ だけ（docs/decisions/tech-stack.md）。
 * ここでは env から Platform を組み立てて渡すだけにし、処理の中身は書かない。
 */
import { createApp } from "./app";
import { runJob } from "./jobs";
import { enqueueDueFeeds } from "./jobs/schedule";
import { createCloudflarePlatform, handleQueueBatch } from "./platform/cloudflare";

export default {
  fetch(request, env, ctx) {
    return createApp(createCloudflarePlatform(env)).fetch(request, env, ctx);
  },

  async scheduled(_controller, env) {
    const count = await enqueueDueFeeds(createCloudflarePlatform(env));
    if (count > 0) console.info("enqueued due feeds", { count });
  },

  async queue(batch, env) {
    const platform = createCloudflarePlatform(env);
    await handleQueueBatch(batch, (job) => runJob(platform, job));
  },
} satisfies ExportedHandler<Env>;
