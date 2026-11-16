-- drizzle-kit はトリガーを扱わないので、このマイグレーションは手で書いている（drizzle-kit generate --custom で作った枠）。
--
-- 設定の行が物理的に消えると（消した印の行の回収、ユーザーの削除）、消した行の番号で
-- seq_floors の下限を引き上げる。0001 のフォルダ・購読のトリガーと同じ形
-- （docs/decisions/sync.md の 1、docs/decisions/settings.md の 3）。

CREATE TRIGGER `client_settings_seq_floor` AFTER DELETE ON `client_settings` BEGIN
  INSERT INTO `seq_floors` (`table_name`, `floor`) VALUES ('client_settings', OLD.`seq`)
    ON CONFLICT (`table_name`) DO UPDATE SET `floor` = max(`floor`, excluded.`floor`);
END;
