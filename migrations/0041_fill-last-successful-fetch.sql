-- 429 は失敗回数に数えないので、last_error も確認する。
-- 解除した Discord フィードは失敗の記録が消されているため対象外。
UPDATE `feeds`
SET `last_successful_fetch_at` = `last_fetched_at`
WHERE `last_successful_fetch_at` IS NULL
  AND `last_fetched_at` IS NOT NULL
  AND `error_count` = 0
  AND `last_error` IS NULL
  AND (`discord_cursor` IS NULL OR `discord_connection_id` IS NOT NULL);
