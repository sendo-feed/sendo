-- 記事の翻訳が変わったら、その記事を持つ受信箱の行すべてに、同じ文の中で新しい変更番号を振る
-- （docs/decisions/sync.md の 10）。差分同期は受信箱の行に訳文を付けて返すので、番号が進めば届く。
-- drizzle-kit はトリガーを扱わないので、手で書いている（drizzle-kit generate --custom で作った枠）。
--
-- 振るのは、行が作られたときと、配る項目（状態、元の言語、訳したタイトル・要約、訳した時刻）の
-- どれかが変わったときだけ。skipped の行は配らないので振らない。回数や始めた時刻だけが変わったとき
-- （やり直しを数えた）も振らない。既読・スター・既読の番号（read_seq）は変えない。
-- 番号の振り方は src/db/seq.ts の nextSeq と同じ（表の最大と下限の大きいほう＋1）。
CREATE TRIGGER article_translations_sync_insert AFTER INSERT ON article_translations
WHEN NEW.status <> 'skipped'
BEGIN
  UPDATE user_articles SET seq = (SELECT max(
    coalesce((SELECT max(seq) FROM user_articles), 0),
    coalesce((SELECT `floor` FROM `seq_floors` WHERE `table_name` = 'user_articles'), 0)
  ) + 1)
  WHERE article_id = NEW.article_id;
END;
--> statement-breakpoint
CREATE TRIGGER article_translations_sync_update
AFTER UPDATE OF status, language, title, summary, translated_at ON article_translations
WHEN NEW.status <> 'skipped' AND (
  OLD.status IS NOT NEW.status
  OR OLD.language IS NOT NEW.language
  OR OLD.title IS NOT NEW.title
  OR OLD.summary IS NOT NEW.summary
  OR OLD.translated_at IS NOT NEW.translated_at
)
BEGIN
  UPDATE user_articles SET seq = (SELECT max(
    coalesce((SELECT max(seq) FROM user_articles), 0),
    coalesce((SELECT `floor` FROM `seq_floors` WHERE `table_name` = 'user_articles'), 0)
  ) + 1)
  WHERE article_id = NEW.article_id;
END;
