import type { Platform } from "../platform";
import { runFetchFeed } from "./fetch-feed";
import type { Job } from "./job";

/** キューから受け取った仕事を1つ実行する。例外を投げたら、キューがやり直す */
export async function runJob(platform: Platform, job: Job): Promise<void> {
  switch (job.type) {
    case "fetch-feed": {
      const outcome = await runFetchFeed(platform, job.feedId);
      if (outcome.status === "failed") {
        console.warn("feed fetch failed", { feedId: job.feedId, error: outcome.error });
      }
      return;
    }
  }
}
