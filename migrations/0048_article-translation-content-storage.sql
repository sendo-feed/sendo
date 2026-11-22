-- 訳した本文（content）も、記事の保管容量に含める（docs/decisions/translation.md の 12、retention.md の 2）。
-- 0045 のトリガーを、本文を数える形に置き換える。容量を超える行と訳文は書かない。
-- drizzle-kit はトリガーを扱わないので、手で書いている（drizzle-kit generate --custom で作った枠）。
DROP TRIGGER article_translations_storage_admission;
--> statement-breakpoint
DROP TRIGGER article_translations_storage_insert;
--> statement-breakpoint
DROP TRIGGER article_translations_storage_delete;
--> statement-breakpoint
DROP TRIGGER article_translations_storage_update_admission;
--> statement-breakpoint
DROP TRIGGER article_translations_storage_update;
--> statement-breakpoint
CREATE TRIGGER article_translations_storage_admission BEFORE INSERT ON article_translations
WHEN NOT EXISTS (SELECT 1 FROM article_translations WHERE article_id = NEW.article_id)
  AND (SELECT bytes + (512 + coalesce(length(cast(NEW.title as blob)), 0) + coalesce(length(cast(NEW.summary as blob)), 0) + coalesce(length(cast(NEW.model as blob)), 0) + coalesce(length(cast(NEW.content as blob)), 0)) > limit_bytes FROM storage_usage WHERE id = 1)
BEGIN
  SELECT RAISE(IGNORE);
END;
--> statement-breakpoint
CREATE TRIGGER article_translations_storage_insert AFTER INSERT ON article_translations BEGIN
  UPDATE storage_usage SET bytes = bytes + (512 + coalesce(length(cast(NEW.title as blob)), 0) + coalesce(length(cast(NEW.summary as blob)), 0) + coalesce(length(cast(NEW.model as blob)), 0) + coalesce(length(cast(NEW.content as blob)), 0)) WHERE id = 1;
END;
--> statement-breakpoint
CREATE TRIGGER article_translations_storage_delete AFTER DELETE ON article_translations BEGIN
  UPDATE storage_usage SET bytes = bytes - (512 + coalesce(length(cast(OLD.title as blob)), 0) + coalesce(length(cast(OLD.summary as blob)), 0) + coalesce(length(cast(OLD.model as blob)), 0) + coalesce(length(cast(OLD.content as blob)), 0)) WHERE id = 1;
END;
--> statement-breakpoint
CREATE TRIGGER article_translations_storage_update_admission BEFORE UPDATE OF title, summary, model, content ON article_translations
WHEN (coalesce(length(cast(NEW.title as blob)), 0) + coalesce(length(cast(NEW.summary as blob)), 0) + coalesce(length(cast(NEW.model as blob)), 0) + coalesce(length(cast(NEW.content as blob)), 0)) > (coalesce(length(cast(OLD.title as blob)), 0) + coalesce(length(cast(OLD.summary as blob)), 0) + coalesce(length(cast(OLD.model as blob)), 0) + coalesce(length(cast(OLD.content as blob)), 0))
  AND (SELECT bytes + (coalesce(length(cast(NEW.title as blob)), 0) + coalesce(length(cast(NEW.summary as blob)), 0) + coalesce(length(cast(NEW.model as blob)), 0) + coalesce(length(cast(NEW.content as blob)), 0)) - (coalesce(length(cast(OLD.title as blob)), 0) + coalesce(length(cast(OLD.summary as blob)), 0) + coalesce(length(cast(OLD.model as blob)), 0) + coalesce(length(cast(OLD.content as blob)), 0)) > limit_bytes FROM storage_usage WHERE id = 1)
BEGIN
  SELECT RAISE(IGNORE);
END;
--> statement-breakpoint
CREATE TRIGGER article_translations_storage_update AFTER UPDATE OF title, summary, model, content ON article_translations BEGIN
  UPDATE storage_usage SET bytes = bytes + (coalesce(length(cast(NEW.title as blob)), 0) + coalesce(length(cast(NEW.summary as blob)), 0) + coalesce(length(cast(NEW.model as blob)), 0) + coalesce(length(cast(NEW.content as blob)), 0)) - (coalesce(length(cast(OLD.title as blob)), 0) + coalesce(length(cast(OLD.summary as blob)), 0) + coalesce(length(cast(OLD.model as blob)), 0) + coalesce(length(cast(OLD.content as blob)), 0)) WHERE id = 1;
END;
