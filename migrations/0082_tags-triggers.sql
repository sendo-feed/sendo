-- drizzle-kit はトリガーを扱わないので、このマイグレーションは手で書いている（drizzle-kit generate --custom で作った枠）。
--
-- タグの行が物理的に消えると（消した印の行の回収、ユーザーの削除）、消した行の番号で seq_floors の
-- 下限を引き上げる。回収した消した印の行は、人ごとの回収の下限にも記録する（docs/decisions/tags.md の 7。
-- 0071_bells-triggers.sql の bells_seq_floor と同じ形）。
CREATE TRIGGER `tags_seq_floor` AFTER DELETE ON `tags` BEGIN
  INSERT INTO `seq_floors` (`table_name`, `floor`) VALUES ('tags', OLD.`seq`)
    ON CONFLICT (`table_name`) DO UPDATE SET `floor` = max(`floor`, excluded.`floor`);
  INSERT INTO `tag_horizons` (`user_id`, `seq`)
    SELECT OLD.`user_id`, OLD.`seq`
    WHERE OLD.`deleted_at` IS NOT NULL
      AND EXISTS (SELECT 1 FROM `users` WHERE `id` = OLD.`user_id`)
    ON CONFLICT (`user_id`) DO UPDATE SET `seq` = max(`seq`, excluded.`seq`);
END;
