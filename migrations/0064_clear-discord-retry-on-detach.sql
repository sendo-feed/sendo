-- 接続や購読の解除で、取得から外れた Discord の待機時刻も消す。
CREATE TRIGGER `discord_retry_detach` AFTER UPDATE OF `discord_connection_id` ON `feeds`
WHEN NEW.`discord_connection_id` IS NULL AND NEW.`discord_retry_at` IS NOT NULL
BEGIN
  UPDATE `feeds` SET `discord_retry_at` = NULL WHERE `id` = NEW.`id`;
END;
