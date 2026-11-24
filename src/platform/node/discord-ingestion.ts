import { setTimeout as delay } from "node:timers/promises";
import { listDiscordFetchTargets } from "../../db/discord";
import { discordChannelUrl, getDiscordGatewayInfo } from "../../discord/client";
import type { Platform } from "..";
import { startDiscordGateway } from "./discord-gateway";

const FETCH_TARGETS_PER_BATCH = 90;
const ENQUEUE_RETRY_DELAY_MS = 1_000;
const MAX_ENQUEUE_RETRIES = 2;

/** Gateway の知らせを、通常の Discord 取得ジョブに渡す。 */
export function startDiscordIngestion(
  platform: Pick<Platform, "db" | "jobs" | "discord" | "fetch">,
  connect?: Parameters<typeof startDiscordGateway>[0]["connect"],
) {
  const { discord, fetch } = platform;
  if (!discord) return;
  const controller = new AbortController();
  const pending = new Set<Promise<void>>();

  async function queueTargets(url?: string) {
    let after: string | undefined;
    let retries = 0;
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
        retries = 0;
      } catch (error) {
        if (controller.signal.aborted) return;
        if (retries === MAX_ENQUEUE_RETRIES) throw error;
        retries++;
        // Gateway の取得位置は進んでいるので、同じ範囲のキュー投入を先にやり直す。
        await delay(ENQUEUE_RETRY_DELAY_MS, undefined, { signal: controller.signal }).catch(
          () => undefined,
        );
      }
    }
  }

  function dispatch(url?: string) {
    const task = queueTargets(url).finally(() => pending.delete(task));
    pending.add(task);
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
      await Promise.allSettled(pending);
    },
  };
}
