-- drizzle-kit が扱わない SQL を、手で書いている（drizzle-kit generate --custom で作った枠）。

-- 1. すでにある受信箱の行の received_seq を埋める。今の seq が、入ったときの番号に最も近い
UPDATE `user_articles` SET `received_seq` = `seq` WHERE `received_seq` = 0;
--> statement-breakpoint

-- 2. フィード（共有）の名前やサイトの URL が変わったら、そのフィードの購読の変更番号を進める
--    （フィードの情報は共有の表にあって番号を持たないので、こうしないと同期でクライアントに伝わらない）。
--    名前の保存と同じ文の中で起きるので、途中で落ちても伝え漏れが起きない。
--    番号の振り方は src/db/seq.ts の nextSeq と同じ（表の最大と下限の大きいほう＋1）。
CREATE TRIGGER `feeds_touch_subscriptions` AFTER UPDATE OF `title`, `site_url` ON `feeds`
WHEN OLD.`title` IS NOT NEW.`title` OR OLD.`site_url` IS NOT NEW.`site_url`
BEGIN
  UPDATE `subscriptions`
  SET `seq` = (SELECT max(
    coalesce((SELECT max(`seq`) FROM `subscriptions`), 0),
    coalesce((SELECT `floor` FROM `seq_floors` WHERE `table_name` = 'subscriptions'), 0)
  ) + 1)
  WHERE `feed_id` = NEW.`id` AND `deleted_at` IS NULL;
END;
