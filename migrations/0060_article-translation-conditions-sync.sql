-- 訳したときのモデルと思考量（model、effort）も差分同期で配る項目に入ったので（docs/decisions/sync.md の
-- 10、translation.md の 14、18）、どちらかが変わったときにも受信箱の行に新しい変更番号を振るよう、0057 の
-- 更新のトリガーを作り直す。drizzle-kit はトリガーを扱わないので、手で書いている（drizzle-kit generate
-- --custom で作った枠）。条件は 0057 に model と effort を足しただけで、ほかは変えない。配らない条件
-- （段階、プロンプトの版、トークン数、呼び出しのモデル、写した元、バッチで送った条件）は見ない。
--
-- 前からある行には番号を振り直さない（行を書き換えない）。前に届いた記事は、ほかの変更で届き直すまで、
-- クライアントにモデルと思考量が届かない（sendo-reader の決定で受け入れた）。
DROP TRIGGER IF EXISTS article_translations_sync_update;
--> statement-breakpoint
CREATE TRIGGER article_translations_sync_update
AFTER UPDATE OF status, language, title, summary, translated_at, retranslated, failure_kind, failure_category, failure_stage, model, effort ON article_translations
WHEN NEW.status <> 'skipped' AND (
  OLD.status IS NOT NEW.status
  OR OLD.language IS NOT NEW.language
  OR OLD.title IS NOT NEW.title
  OR OLD.summary IS NOT NEW.summary
  OR OLD.translated_at IS NOT NEW.translated_at
  OR OLD.retranslated IS NOT NEW.retranslated
  OR OLD.failure_kind IS NOT NEW.failure_kind
  OR OLD.failure_category IS NOT NEW.failure_category
  OR OLD.failure_stage IS NOT NEW.failure_stage
  OR OLD.model IS NOT NEW.model
  OR OLD.effort IS NOT NEW.effort
)
BEGIN
  UPDATE user_articles SET seq = (SELECT max(
    coalesce((SELECT max(seq) FROM user_articles), 0),
    coalesce((SELECT `floor` FROM `seq_floors` WHERE `table_name` = 'user_articles'), 0)
  ) + 1)
  WHERE article_id = NEW.article_id;
END;
