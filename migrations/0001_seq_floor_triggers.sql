-- 変更番号の下限を、削除と同じ文の中で記録するトリガー（docs/decisions/sync.md）。
-- drizzle-kit はトリガーを扱わないので、このマイグレーションは手で書いている（drizzle-kit generate --custom で作った枠）。
--
-- 人ごとの表から行が物理的に消えると、消した行の番号で seq_floors の下限を引き上げる
-- （下限の行がなければ作る。行が消されていても守りが外れないように）。
-- 番号は「表の最大と下限の大きいほう＋1」で振る（src/db/seq.ts）ので、いちばん大きい番号の行を
-- 消しても、その番号は二度と振られない。

CREATE TRIGGER `folders_seq_floor` AFTER DELETE ON `folders` BEGIN
  INSERT INTO `seq_floors` (`table_name`, `floor`) VALUES ('folders', OLD.`seq`)
    ON CONFLICT (`table_name`) DO UPDATE SET `floor` = max(`floor`, excluded.`floor`);
END;
--> statement-breakpoint
CREATE TRIGGER `subscriptions_seq_floor` AFTER DELETE ON `subscriptions` BEGIN
  INSERT INTO `seq_floors` (`table_name`, `floor`) VALUES ('subscriptions', OLD.`seq`)
    ON CONFLICT (`table_name`) DO UPDATE SET `floor` = max(`floor`, excluded.`floor`);
END;
--> statement-breakpoint
CREATE TRIGGER `user_articles_seq_floor` AFTER DELETE ON `user_articles` BEGIN
  INSERT INTO `seq_floors` (`table_name`, `floor`) VALUES ('user_articles', OLD.`seq`)
    ON CONFLICT (`table_name`) DO UPDATE SET `floor` = max(`floor`, excluded.`floor`);
END;
