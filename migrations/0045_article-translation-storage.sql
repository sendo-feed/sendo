-- 訳文の行（見積もり 512 バイト）と、訳したタイトル・要約・モデルの文字のバイト数を、記事の保管容量に含める
-- （docs/decisions/translation.md の 12、retention.md の 2）。容量を超える行と訳文は書かない。
CREATE TRIGGER article_translations_storage_admission BEFORE INSERT ON article_translations
WHEN NOT EXISTS (SELECT 1 FROM article_translations WHERE article_id = NEW.article_id)
  AND (SELECT bytes + (512 + coalesce(length(cast(NEW.title as blob)), 0) + coalesce(length(cast(NEW.summary as blob)), 0) + coalesce(length(cast(NEW.model as blob)), 0)) > limit_bytes FROM storage_usage WHERE id = 1)
BEGIN
  SELECT RAISE(IGNORE);
END;
--> statement-breakpoint
CREATE TRIGGER article_translations_storage_insert AFTER INSERT ON article_translations BEGIN
  UPDATE storage_usage SET bytes = bytes + (512 + coalesce(length(cast(NEW.title as blob)), 0) + coalesce(length(cast(NEW.summary as blob)), 0) + coalesce(length(cast(NEW.model as blob)), 0)) WHERE id = 1;
END;
--> statement-breakpoint
CREATE TRIGGER article_translations_storage_delete AFTER DELETE ON article_translations BEGIN
  UPDATE storage_usage SET bytes = bytes - (512 + coalesce(length(cast(OLD.title as blob)), 0) + coalesce(length(cast(OLD.summary as blob)), 0) + coalesce(length(cast(OLD.model as blob)), 0)) WHERE id = 1;
END;
--> statement-breakpoint
CREATE TRIGGER article_translations_storage_update_admission BEFORE UPDATE OF title, summary, model ON article_translations
WHEN (coalesce(length(cast(NEW.title as blob)), 0) + coalesce(length(cast(NEW.summary as blob)), 0) + coalesce(length(cast(NEW.model as blob)), 0))
  > (coalesce(length(cast(OLD.title as blob)), 0) + coalesce(length(cast(OLD.summary as blob)), 0) + coalesce(length(cast(OLD.model as blob)), 0))
  AND (SELECT bytes
    + coalesce(length(cast(NEW.title as blob)), 0) + coalesce(length(cast(NEW.summary as blob)), 0) + coalesce(length(cast(NEW.model as blob)), 0)
    - coalesce(length(cast(OLD.title as blob)), 0) - coalesce(length(cast(OLD.summary as blob)), 0) - coalesce(length(cast(OLD.model as blob)), 0)
    > limit_bytes FROM storage_usage WHERE id = 1)
BEGIN
  SELECT RAISE(IGNORE);
END;
--> statement-breakpoint
CREATE TRIGGER article_translations_storage_update AFTER UPDATE OF title, summary, model ON article_translations BEGIN
  UPDATE storage_usage SET bytes = bytes
    + coalesce(length(cast(NEW.title as blob)), 0) + coalesce(length(cast(NEW.summary as blob)), 0) + coalesce(length(cast(NEW.model as blob)), 0)
    - coalesce(length(cast(OLD.title as blob)), 0) - coalesce(length(cast(OLD.summary as blob)), 0) - coalesce(length(cast(OLD.model as blob)), 0)
    WHERE id = 1;
END;
