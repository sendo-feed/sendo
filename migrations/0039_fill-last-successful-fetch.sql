-- 以前の記録から成功と分かるのは、最後の試行に失敗の記録がない場合だけ。
-- 429 は失敗回数に数えないので、last_error も確認する。
UPDATE `feeds`
SET `last_successful_fetch_at` = `last_fetched_at`
WHERE `last_successful_fetch_at` IS NULL
  AND `last_fetched_at` IS NOT NULL
  AND `error_count` = 0
  AND `last_error` IS NULL;
