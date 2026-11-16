import { extractPageContentOnce } from "../fetcher/page-content";
import type { Platform } from "../platform";
import { runCleanUp } from "./clean-up";
import { runFetchFeed } from "./fetch-feed";
import { runImportFeeds } from "./import-feeds";
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
    case "clean-up": {
      console.info("cleaned up", await runCleanUp(platform));
      return;
    }
    case "extract-page": {
      // ページから抜けない版では積まないが、積まれていたら（版を移った直後など）捨てる
      if (platform.pageContent === undefined) {
        console.warn("dropping extract-page job; page content is not available on this edition");
        return;
      }
      await extractPageContentOnce(platform, platform.pageContent, job.articleId);
      return;
    }
    case "import-feeds": {
      await runImportFeeds(platform, { userId: job.userId, entries: job.feeds });
      return;
    }
  }
}
