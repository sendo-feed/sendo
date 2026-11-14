-- 受信箱の行が物理的に消えたら、削除と同じ文の中で「消した記録」を残す（docs/decisions/sync.md の 3）。
-- drizzle-kit はトリガーを扱わないので、手で書いている（drizzle-kit generate --custom で作った枠）。
--
-- 0001 の user_articles_seq_floor（消した行の番号で下限を引き上げる）を、次の形に置き換える。
-- 1. 下限を「表の最大、下限、消した行の番号のいちばん大きいもの＋1」に引き上げる（下限の行がなければ作る）
-- 2. その番号で、消した記録を残す。同じ記事の記録がすでにあれば、番号と時刻を振り直す
-- 番号の振り方は src/db/seq.ts の nextSeq と同じ（表の最大と下限の大きいほう＋1）なので、記録の番号は
-- 受信箱の行の番号と重ならず、あとから振る番号はどれも記録の番号より大きくなる。
--
-- ユーザーを消したとき（受信箱の行は連鎖して消える）は、伝える相手がいないので記録を残さない。

DROP TRIGGER `user_articles_seq_floor`;
--> statement-breakpoint
CREATE TRIGGER `user_articles_removed` AFTER DELETE ON `user_articles` BEGIN
  INSERT INTO `seq_floors` (`table_name`, `floor`)
  VALUES ('user_articles', max(
    coalesce((SELECT max(`seq`) FROM `user_articles`), 0),
    coalesce((SELECT `floor` FROM `seq_floors` WHERE `table_name` = 'user_articles'), 0),
    OLD.`seq`
  ) + 1)
  ON CONFLICT (`table_name`) DO UPDATE SET `floor` = max(`floor`, excluded.`floor`);

  INSERT INTO `user_article_removals` (`user_id`, `article_id`, `seq`, `removed_at`)
  SELECT
    OLD.`user_id`,
    OLD.`article_id`,
    (SELECT `floor` FROM `seq_floors` WHERE `table_name` = 'user_articles'),
    cast(unixepoch('subsec') * 1000 as integer)
  WHERE EXISTS (SELECT 1 FROM `users` WHERE `id` = OLD.`user_id`)
  ON CONFLICT (`user_id`, `article_id`) DO UPDATE
    SET `seq` = excluded.`seq`, `removed_at` = excluded.`removed_at`;
END;
