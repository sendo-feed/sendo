-- drizzle-kit が扱わないトリガーを入れるためのカスタムマイグレーション。
CREATE TRIGGER `saved_pages_seq_floor` AFTER DELETE ON `saved_pages` BEGIN
  INSERT INTO `seq_floors` (`table_name`, `floor`) VALUES ('saved_pages', OLD.`seq`)
    ON CONFLICT (`table_name`) DO UPDATE SET `floor` = max(`floor`, excluded.`floor`);
  INSERT INTO `saved_page_horizons` (`user_id`, `seq`)
    SELECT OLD.`user_id`, OLD.`seq`
    WHERE OLD.`deleted_at` IS NOT NULL
      AND EXISTS (SELECT 1 FROM `users` WHERE `id` = OLD.`user_id`)
    ON CONFLICT (`user_id`) DO UPDATE SET `seq` = max(`seq`, excluded.`seq`);
END;
