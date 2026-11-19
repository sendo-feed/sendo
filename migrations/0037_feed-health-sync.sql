-- 取得状態、理由のコード、移転先候補の変化を購読の差分同期に載せる（docs/decisions/jobs.md の 10）。
-- 失敗回数は、active と failing の切り替わりだけを見る。
DROP TRIGGER IF EXISTS `feeds_touch_subscriptions`;
--> statement-breakpoint
CREATE TRIGGER `feeds_touch_subscriptions` AFTER UPDATE OF `title`, `site_url`, `icon_url`, `fetch_stalled`, `error_count`, `last_error_code`, `relocation_candidate` ON `feeds`
WHEN OLD.`title` IS NOT NEW.`title` OR OLD.`site_url` IS NOT NEW.`site_url`
  OR OLD.`icon_url` IS NOT NEW.`icon_url`
  OR OLD.`fetch_stalled` IS NOT NEW.`fetch_stalled`
  OR (OLD.`fetch_stalled` = 0 AND NEW.`fetch_stalled` = 0
    AND (OLD.`error_count` > 0) IS NOT (NEW.`error_count` > 0))
  OR OLD.`last_error_code` IS NOT NEW.`last_error_code`
  OR OLD.`relocation_candidate` IS NOT NEW.`relocation_candidate`
BEGIN
  UPDATE `subscriptions`
  SET `seq` = (SELECT max(
    coalesce((SELECT max(`seq`) FROM `subscriptions`), 0),
    coalesce((SELECT `floor` FROM `seq_floors` WHERE `table_name` = 'subscriptions'), 0)
  ) + 1)
  WHERE `feed_id` = NEW.`id` AND `deleted_at` IS NULL;
END;
