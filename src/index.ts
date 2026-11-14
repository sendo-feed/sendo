/**
 * Worker の入口。
 *
 * Cloudflare のバインディング（env）に触れてよいのは、このファイルと
 * src/platform/cloudflare/ だけ（docs/decisions/tech-stack.md）。
 * ここでは env から実装を組み立てて渡すだけにし、処理の中身は書かない。
 */
import { createApp } from "./app";

const app = createApp();

export default {
  fetch: (request, env, ctx) => app.fetch(request, env, ctx),
} satisfies ExportedHandler<Env>;
