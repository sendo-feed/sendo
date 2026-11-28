-- drizzle-kit はトリガーを扱わないので、このマイグレーションは手で書いている（drizzle-kit generate --custom で作った枠）。
--
-- 記事の解析の行と候補の語を、記事の保管容量に含める（docs/decisions/retention.md の 2、
-- docs/decisions/article-analysis.md の 12）。解析の行はベクトルのバイト数に 1 行 256 バイト、候補の行は
-- 表記とまとめの鍵のバイト数に 1 行 128 バイト。書き込みと同じ文の中で集計する。容量の確かめは、
-- 書く文の中で行う（片付けの始まる 90% の手前で止めるため。db/article-analyses.ts）。
CREATE TRIGGER `article_analyses_storage_insert` AFTER INSERT ON `article_analyses` BEGIN
  UPDATE `storage_usage` SET `bytes` = `bytes` + 256 + coalesce(length(NEW.`embedding`), 0) WHERE `id` = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `article_analyses_storage_update` AFTER UPDATE OF `embedding` ON `article_analyses` BEGIN
  UPDATE `storage_usage` SET `bytes` = `bytes` + coalesce(length(NEW.`embedding`), 0) - coalesce(length(OLD.`embedding`), 0)
  WHERE `id` = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `article_analyses_storage_delete` AFTER DELETE ON `article_analyses` BEGIN
  UPDATE `storage_usage` SET `bytes` = `bytes` - 256 - coalesce(length(OLD.`embedding`), 0) WHERE `id` = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `article_candidates_storage_insert` AFTER INSERT ON `article_candidates` BEGIN
  UPDATE `storage_usage` SET `bytes` = `bytes` + 128
    + length(cast(NEW.`key` AS blob)) + length(cast(NEW.`surface` AS blob)) WHERE `id` = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `article_candidates_storage_delete` AFTER DELETE ON `article_candidates` BEGIN
  UPDATE `storage_usage` SET `bytes` = `bytes` - 128
    - length(cast(OLD.`key` AS blob)) - length(cast(OLD.`surface` AS blob)) WHERE `id` = 1;
END;
