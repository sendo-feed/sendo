-- drizzle-kit はトリガーを扱わないので、このマイグレーションは手で書いている（drizzle-kit generate --custom で作った枠）。
--
-- 購読に消した印が付くと（購読をやめる、Discord の切り離しのトリガー）、同じ文の中で、その購読の
-- ベルにも消した印と新しい変更番号を付ける（docs/decisions/notifications.md の 3）。購読を消す処理が
-- ベルを消し忘れず、間で落ちても、消えた購読を指すベルが残らない。
CREATE TRIGGER `subscriptions_end_bells` AFTER UPDATE OF `deleted_at` ON `subscriptions`
WHEN OLD.`deleted_at` IS NULL AND NEW.`deleted_at` IS NOT NULL
BEGIN
  UPDATE `bells` SET
    `deleted_at` = NEW.`deleted_at`,
    `seq` = (SELECT max(
      coalesce((SELECT max(`seq`) FROM `bells`), 0),
      coalesce((SELECT `floor` FROM `seq_floors` WHERE `table_name` = 'bells'), 0)
    ) + 1)
  WHERE `subscription_id` = NEW.`id` AND `deleted_at` IS NULL;
END;
--> statement-breakpoint
-- ベルの行が物理的に消えると（消した印の行の回収、ユーザーの削除）、消した行の番号で
-- seq_floors の下限を引き上げる。回収した消した印の行は、人ごとの回収の下限にも記録する
-- （0031_saved_pages_seq_floor.sql と同じ形）。
CREATE TRIGGER `bells_seq_floor` AFTER DELETE ON `bells` BEGIN
  INSERT INTO `seq_floors` (`table_name`, `floor`) VALUES ('bells', OLD.`seq`)
    ON CONFLICT (`table_name`) DO UPDATE SET `floor` = max(`floor`, excluded.`floor`);
  INSERT INTO `bell_horizons` (`user_id`, `seq`)
    SELECT OLD.`user_id`, OLD.`seq`
    WHERE OLD.`deleted_at` IS NOT NULL
      AND EXISTS (SELECT 1 FROM `users` WHERE `id` = OLD.`user_id`)
    ON CONFLICT (`user_id`) DO UPDATE SET `seq` = max(`seq`, excluded.`seq`);
END;
