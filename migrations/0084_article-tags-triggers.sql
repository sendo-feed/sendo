-- drizzle-kit はトリガーを扱わないので、このマイグレーションは手で書いている（drizzle-kit generate --custom で作った枠）。
--
-- 記事のタグ（docs/decisions/tags.md の 5、7、8）。

-- 受信箱の行が消えたら、消えた行のユーザーと記事の ID で絞った記事のタグのうち、消した印のない行に、同じ文の
-- 中で消した印と新しい変更番号を付ける（手で付け外ししたものも）。ほかの人の行には触らない。記事の行への
-- 外部キーでは連鎖させない（消した印を 30 日残すため）
CREATE TRIGGER `user_articles_end_article_tags` AFTER DELETE ON `user_articles` BEGIN
  UPDATE `article_tags` SET
    `deleted_at` = cast(unixepoch('subsec') * 1000 as integer),
    `seq` = (SELECT max(
      coalesce((SELECT max(`seq`) FROM `article_tags`), 0),
      coalesce((SELECT `floor` FROM `seq_floors` WHERE `table_name` = 'article_tags'), 0)
    ) + 1)
  WHERE `user_id` = OLD.`user_id` AND `article_id` = OLD.`article_id` AND `deleted_at` IS NULL;
END;
--> statement-breakpoint
-- タグを消すと（消した印を付ける）、そのタグの記事のタグのうち消した印のない行に、同じ文の中で消した印と
-- 新しい変更番号を付ける
CREATE TRIGGER `tags_end_article_tags` AFTER UPDATE OF `deleted_at` ON `tags`
WHEN OLD.`deleted_at` IS NULL AND NEW.`deleted_at` IS NOT NULL
BEGIN
  UPDATE `article_tags` SET
    `deleted_at` = NEW.`deleted_at`,
    `seq` = (SELECT max(
      coalesce((SELECT max(`seq`) FROM `article_tags`), 0),
      coalesce((SELECT `floor` FROM `seq_floors` WHERE `table_name` = 'article_tags'), 0)
    ) + 1)
  WHERE `tag_id` = NEW.`id` AND `deleted_at` IS NULL;
END;
--> statement-breakpoint
-- 記事のタグの行が物理的に消えると（消した印の行の回収、タグやユーザーの削除の連鎖）、消した行の番号で
-- seq_floors の下限を引き上げ、回収した消した印の行は人ごとの回収の下限にも記録する（0082 と同じ形）
CREATE TRIGGER `article_tags_seq_floor` AFTER DELETE ON `article_tags` BEGIN
  INSERT INTO `seq_floors` (`table_name`, `floor`) VALUES ('article_tags', OLD.`seq`)
    ON CONFLICT (`table_name`) DO UPDATE SET `floor` = max(`floor`, excluded.`floor`);
  INSERT INTO `article_tag_horizons` (`user_id`, `seq`)
    SELECT OLD.`user_id`, OLD.`seq`
    WHERE OLD.`deleted_at` IS NOT NULL
      AND EXISTS (SELECT 1 FROM `users` WHERE `id` = OLD.`user_id`)
    ON CONFLICT (`user_id`) DO UPDATE SET `seq` = max(`seq`, excluded.`seq`);
END;
--> statement-breakpoint
-- 記事のタグを保存容量に含める（1 行 256 バイト。docs/decisions/retention.md の 2）。手の付け外しは、受信箱の
-- 行と同じく上限では断らない（受け入れの止めは置かない）
CREATE TRIGGER `article_tags_storage_insert` AFTER INSERT ON `article_tags` BEGIN
  UPDATE `storage_usage` SET `bytes` = `bytes` + 256 WHERE `id` = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `article_tags_storage_delete` AFTER DELETE ON `article_tags` BEGIN
  UPDATE `storage_usage` SET `bytes` = `bytes` - 256 WHERE `id` = 1;
END;
