-- 購読の消した印は同期に必要なので、フィードを直接消さず、内容だけを外す。
-- 連携解除、権限の喪失、個別の購読解除は、同じ処理で記事（スター付きも含む）を消す。
CREATE TRIGGER `discord_feed_detach` AFTER UPDATE OF `discord_connection_id` ON `feeds`
WHEN OLD.`discord_connection_id` IS NOT NULL AND NEW.`discord_connection_id` IS NULL
BEGIN
  UPDATE `subscriptions` SET
    `deleted_at` = CAST(unixepoch('subsec') * 1000 AS INTEGER),
    `display_name` = NULL,
    `seq` = max(
      coalesce((SELECT max(`seq`) FROM `subscriptions`), 0),
      coalesce((SELECT `floor` FROM `seq_floors` WHERE `table_name` = 'subscriptions'), 0)
    ) + 1
  WHERE `feed_id` = NEW.`id` AND `deleted_at` IS NULL;

  UPDATE `feeds` SET `url` = '', `site_url` = NULL, `title` = NULL,
    `discord_cursor` = '0', `last_error` = NULL, `last_error_code` = NULL,
    `error_count` = 0, `failure_started_at` = NULL, `fetch_stalled` = 0, `relocation_candidate` = NULL
  WHERE `id` = NEW.`id`;

  DELETE FROM `articles` WHERE `feed_id` = NEW.`id`;
END;
--> statement-breakpoint
-- ALTER TABLE ADD COLUMN で作る参照では、drizzle-kit が ON DELETE の動作を出力しない。
CREATE TRIGGER `discord_connection_detach` BEFORE DELETE ON `discord_connections` BEGIN
  UPDATE `feeds` SET `discord_connection_id` = NULL WHERE `discord_connection_id` = OLD.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `discord_subscription_owner` BEFORE INSERT ON `subscriptions`
WHEN EXISTS (
  SELECT 1 FROM `feeds` LEFT JOIN `discord_connections`
    ON `discord_connections`.`id` = `feeds`.`discord_connection_id`
  WHERE `feeds`.`id` = NEW.`feed_id` AND `feeds`.`discord_cursor` IS NOT NULL
    AND (`discord_connections`.`user_id` IS NULL OR `discord_connections`.`user_id` <> NEW.`user_id`)
)
BEGIN
  SELECT RAISE(ABORT, 'discord subscription owner mismatch');
END;
