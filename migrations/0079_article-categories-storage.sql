-- drizzle-kit はトリガーを扱わないので、このマイグレーションは手で書いている（drizzle-kit generate --custom で作った枠）。
--
-- フィードのカテゴリを、記事の保管容量に含める（docs/decisions/retention.md の 2、
-- docs/decisions/article-analysis.md の 12）。文字列のバイト数に 1 行 128 バイト。記事の情報と同じく、
-- 上限を超える行は入れない。
CREATE TRIGGER `article_categories_storage_admission` BEFORE INSERT ON `article_categories`
WHEN (SELECT `bytes` + 128 + length(cast(NEW.`name` AS blob)) > `limit_bytes` FROM `storage_usage` WHERE `id` = 1)
BEGIN
  SELECT RAISE(IGNORE);
END;
--> statement-breakpoint
CREATE TRIGGER `article_categories_storage_insert` AFTER INSERT ON `article_categories` BEGIN
  UPDATE `storage_usage` SET `bytes` = `bytes` + 128 + length(cast(NEW.`name` AS blob)) WHERE `id` = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `article_categories_storage_delete` AFTER DELETE ON `article_categories` BEGIN
  UPDATE `storage_usage` SET `bytes` = `bytes` - 128 - length(cast(OLD.`name` AS blob)) WHERE `id` = 1;
END;
