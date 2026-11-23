-- 訳せなかった理由（failure_kind、failure_category、failure_stage）も差分同期で配る項目に入ったので
-- （docs/decisions/sync.md の 10、translation.md の 14、17）、理由が変わったときにも受信箱の行に新しい
-- 変更番号を振るよう、0053 の更新のトリガーを作り直す。drizzle-kit はトリガーを扱わないので、手で
-- 書いている（drizzle-kit generate --custom で作った枠）。条件は 0053 に理由を足しただけで、ほかは
-- 変えない。
DROP TRIGGER IF EXISTS article_translations_sync_update;
--> statement-breakpoint
CREATE TRIGGER article_translations_sync_update
AFTER UPDATE OF status, language, title, summary, translated_at, retranslated, failure_kind, failure_category, failure_stage ON article_translations
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
)
BEGIN
  UPDATE user_articles SET seq = (SELECT max(
    coalesce((SELECT max(seq) FROM user_articles), 0),
    coalesce((SELECT `floor` FROM `seq_floors` WHERE `table_name` = 'user_articles'), 0)
  ) + 1)
  WHERE article_id = NEW.article_id;
END;
