-- Discord のフィードの内容を外すときに、サーバーのアイコンも外す（docs/decisions/discord.md の 5、7）。
-- 0039 で作ったトリガーを、icon_url と icon_checked_at も空にする形に置き換える。
DROP TRIGGER IF EXISTS `discord_feed_detach`;
--> statement-breakpoint
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

  UPDATE `feeds` SET `url` = '', `site_url` = NULL, `title` = NULL, `icon_url` = NULL,
    `icon_checked_at` = NULL, `discord_cursor` = '0', `last_error` = NULL, `last_error_code` = NULL,
    `error_count` = 0, `failure_started_at` = NULL, `fetch_stalled` = 0, `relocation_candidate` = NULL
  WHERE `id` = NEW.`id`;

  DELETE FROM `articles` WHERE `feed_id` = NEW.`id`;
END;
--> statement-breakpoint
-- すでに外した Discord のフィードに残ったアイコンも空にする。
UPDATE `feeds` SET `icon_url` = NULL, `icon_checked_at` = NULL
WHERE `discord_cursor` IS NOT NULL AND `discord_connection_id` IS NULL AND `icon_url` IS NOT NULL;
