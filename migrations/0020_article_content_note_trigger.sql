-- drizzle-kit はトリガーを扱わないので、このマイグレーションは手で書いている（drizzle-kit generate --custom で作った枠）。
--
-- 本文のある記事の行が物理的に消えたら、削除と同じ文の中で、その本文の置き場の名前を書き留める
-- （docs/decisions/content.md の 4）。記事を消す処理（取得のジョブ、1 日 1 回の片付け、フィードが
-- 消えたときの連鎖）は置き場に触らず、1 日 1 回の片付けが、書き留めを見て本文を消す。
--
-- 時刻は DB の時計。同じ名前の書き留めがすでにあれば（取り込みの途中で落ちた分など）、そのままにする。

CREATE TRIGGER `articles_content_note` AFTER DELETE ON `articles`
WHEN OLD.`content_key` IS NOT NULL BEGIN
  INSERT INTO `content_notes` (`key`, `created_at`)
  VALUES (OLD.`content_key`, cast(unixepoch('subsec') * 1000 as integer))
  ON CONFLICT (`key`) DO NOTHING;
END;
