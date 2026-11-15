-- drizzle-kit が扱わない SQL を、手で書いている（drizzle-kit generate --custom で作った枠）。

-- フィード（共有）のアイコンが変わったときも、そのフィードの購読の変更番号を進める
-- （docs/decisions/images.md の 8）。0003 で作ったトリガーを、icon_url も見る形に置き換える。
-- 番号の振り方は src/db/seq.ts の nextSeq と同じ（表の最大と下限の大きいほう＋1）。
DROP TRIGGER IF EXISTS `feeds_touch_subscriptions`;
--> statement-breakpoint
CREATE TRIGGER `feeds_touch_subscriptions` AFTER UPDATE OF `title`, `site_url`, `icon_url` ON `feeds`
WHEN OLD.`title` IS NOT NEW.`title` OR OLD.`site_url` IS NOT NEW.`site_url`
  OR OLD.`icon_url` IS NOT NEW.`icon_url`
BEGIN
  UPDATE `subscriptions`
  SET `seq` = (SELECT max(
    coalesce((SELECT max(`seq`) FROM `subscriptions`), 0),
    coalesce((SELECT `floor` FROM `seq_floors` WHERE `table_name` = 'subscriptions'), 0)
  ) + 1)
  WHERE `feed_id` = NEW.`id` AND `deleted_at` IS NULL;
END;
