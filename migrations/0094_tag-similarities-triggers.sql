-- drizzle-kit はトリガーを扱わないので、このマイグレーションは手で書いている（drizzle-kit generate --custom で作った枠）。
--
-- タグと記事の類似度（docs/decisions/auto-tagging.md の 3、7）。

-- タグに消した印が付いたら、そのタグの行を同じ文の中で消す（タグの行は 30 日残るが、類似度は残さない）
CREATE TRIGGER `tags_end_similarities` AFTER UPDATE OF `deleted_at` ON `tags`
WHEN OLD.`deleted_at` IS NULL AND NEW.`deleted_at` IS NOT NULL
BEGIN
  DELETE FROM `tag_similarities` WHERE `tag_id` = NEW.`id`;
END;
--> statement-breakpoint
-- 受信箱の行が消えたら、そのユーザーと記事の行を消す
CREATE TRIGGER `user_articles_end_similarities` AFTER DELETE ON `user_articles` BEGIN
  DELETE FROM `tag_similarities` WHERE `user_id` = OLD.`user_id` AND `article_id` = OLD.`article_id`;
END;
--> statement-breakpoint
-- 保存容量に含める（1 行 128 バイト。docs/decisions/retention.md の 2）
CREATE TRIGGER `tag_similarities_storage_insert` AFTER INSERT ON `tag_similarities` BEGIN
  UPDATE `storage_usage` SET `bytes` = `bytes` + 128 WHERE `id` = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `tag_similarities_storage_delete` AFTER DELETE ON `tag_similarities` BEGIN
  UPDATE `storage_usage` SET `bytes` = `bytes` - 128 WHERE `id` = 1;
END;
--> statement-breakpoint
-- 上限を超える行は入れない（ほかの表と同じ受け入れの止め）。ふだんは書く文の中の 90% の確かめが先に止める
CREATE TRIGGER `tag_similarities_storage_admission` BEFORE INSERT ON `tag_similarities`
WHEN (SELECT `bytes` + 128 > `limit_bytes` FROM `storage_usage` WHERE `id` = 1)
BEGIN
  SELECT RAISE(IGNORE);
END;
