import { extractPageContentOnce } from "../fetcher/page-content";
import type { Platform } from "../platform";
import { detectArticleLanguages } from "./article-languages";
import { indexArticleSearch } from "./article-search";
import { runBundleBellNotification, runSendBellNotification } from "./bell-notifications";
import { runCleanUp, sweepBellNotifications } from "./clean-up";
import { runFetchFeed } from "./fetch-feed";
import { runImportFeeds } from "./import-feeds";
import type { Job } from "./job";
import { maintainTranslations, runDecideTranslations, runTranslateArticle } from "./translations";

/** キューから受け取った仕事を1つ実行する。例外を投げたら、キューがやり直す */
export async function runJob(platform: Platform, job: Job): Promise<void> {
  switch (job.type) {
    case "index-article-search": {
      await indexArticleSearch(platform);
      return;
    }
    case "detect-article-languages": {
      await detectArticleLanguages(platform, job.after, job.articleIds);
      return;
    }
    case "fetch-feed":
    case "fetch-discord": {
      const outcome = await runFetchFeed(platform, job.feedId, job.type);
      if (outcome.status === "failed") {
        console.warn("feed fetch failed", { feedId: job.feedId, error: outcome.error });
      }
      return;
    }
    case "clean-up": {
      console.info("cleaned up", await runCleanUp(platform));
      return;
    }
    case "clean-up-bell-notifications": {
      console.info("cleaned up", { bellNotifications: await sweepBellNotifications(platform) });
      return;
    }
    case "maintain-translations": {
      const result = await maintainTranslations(platform);
      if (Object.values(result).some((count) => count > 0)) {
        console.info("maintained translations", result);
      }
      return;
    }
    case "decide-translations": {
      await runDecideTranslations(platform, job.articleIds);
      return;
    }
    case "translate-article": {
      await runTranslateArticle(platform, job.articleId, new Date(job.startedAt), {
        retranslation: job.retranslation === true,
      });
      return;
    }
    case "bundle-bell-notifications": {
      await runBundleBellNotification(platform, job);
      return;
    }
    case "send-bell-notification": {
      await runSendBellNotification(platform, job);
      return;
    }
    case "extract-page": {
      await extractPageContentOnce(platform, platform.pageContent, job.articleId);
      return;
    }
    case "import-feeds": {
      await runImportFeeds(platform, { userId: job.userId, entries: job.feeds });
      return;
    }
  }
}
