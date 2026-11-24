import { setTimeout as delay } from "node:timers/promises";
import { listDiscordFetchTargets } from "../../db/discord";
import { discordChannelUrl, getDiscordGatewayInfo } from "../../discord/client";
import type { Platform } from "..";
import { startDiscordGateway } from "./discord-gateway";

const FETCH_TARGETS_PER_BATCH = 90;
const ENQUEUE_RETRY_DELAY_MS = 1_000;
const MAX_ENQUEUE_RETRY_DELAY_MS = 30_000;

/** Gateway の知らせを、通常の Discord 取得ジョブに渡す。 */
export function startDiscordIngestion(
  platform: Pick<Platform, "db" | "jobs" | "discord" | "fetch">,
  connect?: Parameters<typeof startDiscordGateway>[0]["connect"],
) {
  const { discord, fetch } = platform;
  if (!discord) return;
  const controller = new AbortController();
  const pending = new Map<string | undefined, { task: Promise<void>; requestAgain(): void }>();

  async function queueTargets(url?: string) {
    let after: string | undefined;
    let retryDelay = ENQUEUE_RETRY_DELAY_MS;
    while (!controller.signal.aborted) {
      try {
        const targets = await listDiscordFetchTargets(platform.db, {
          url,
          after,
          limit: FETCH_TARGETS_PER_BATCH,
        });
        if (controller.signal.aborted || targets.length === 0) return;
        await platform.jobs.enqueue(
          targets.map(({ feedId }) => ({ type: "fetch-discord", feedId })),
        );
        if (targets.length < FETCH_TARGETS_PER_BATCH) return;
        after = targets.at(-1)?.feedId;
        retryDelay = ENQUEUE_RETRY_DELAY_MS;
      } catch {
        if (controller.signal.aborted) return;
        if (retryDelay === ENQUEUE_RETRY_DELAY_MS) {
          console.warn("Could not queue Discord fetch; retrying");
        }
        // Gateway から同じ投稿が再送されるとは限らないので、成功するまで同じ範囲を持つ。
        await delay(retryDelay, undefined, { signal: controller.signal }).catch(() => undefined);
        retryDelay = Math.min(retryDelay * 2, MAX_ENQUEUE_RETRY_DELAY_MS);
      }
    }
  }

  function dispatch(url?: string) {
    const active = pending.get(url);
    if (active) {
      active.requestAgain();
      return Promise.resolve();
    }
    let again = false;
    async function run() {
      try {
        do {
          again = false;
          await queueTargets(url);
        } while (again && !controller.signal.aborted);
      } finally {
        pending.delete(url);
      }
    }
    const task = run();
    pending.set(url, {
      task,
      requestAgain() {
        again = true;
      },
    });
    return task;
  }

  const gateway = startDiscordGateway({
    token: discord.botToken,
    getGatewayInfo: () => getDiscordGatewayInfo(fetch, discord),
    onMessage: (address) => dispatch(discordChannelUrl(address)),
    onReady: () => dispatch(),
    ...(connect && { connect }),
  });
  return {
    async stop() {
      controller.abort();
      gateway.stop();
      await Promise.allSettled(Array.from(pending.values(), ({ task }) => task));
    },
  };
}
