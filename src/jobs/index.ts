import { extractPageContentOnce } from "../fetcher/page-content";
import type { Platform } from "../platform";
import { detectArticleLanguages } from "./article-languages";
import { indexArticleSearch } from "./article-search";
import { runCleanUp } from "./clean-up";
import { runFetchFeed } from "./fetch-feed";
import { runImportFeeds } from "./import-feeds";
import type { Job } from "./job";
import { maintainTranslations, runTranslateArticle } from "./translations";

/** キューから受け取った仕事を1つ実行する。例外を投げたら、キューがやり直す */
export async function runJob(platform: Platform, job: Job): Promise<void> {
  switch (job.type) {
    case "index-article-search": {
      await indexArticleSearch(platform);
      return;
    }
    case "detect-article-languages": {
      await detectArticleLanguages(platform, job.after);
      return;
    }
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
    case "maintain-translations": {
      const result = await maintainTranslations(platform);
      if (Object.values(result).some((count) => count > 0)) {
        console.info("maintained translations", result);
      }
      return;
    }
    case "translate-article": {
      await runTranslateArticle(platform, job.articleId, new Date(job.startedAt), {
        retranslation: job.retranslation === true,
      });
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
