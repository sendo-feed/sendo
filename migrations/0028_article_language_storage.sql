-- 判定の行と主キー索引の見積もりを、記事の保管容量に含める。
CREATE TRIGGER article_languages_storage_admission BEFORE INSERT ON article_languages
WHEN NOT EXISTS (
  SELECT 1 FROM article_languages WHERE article_id = NEW.article_id AND source = NEW.source
) AND (SELECT bytes + 512 > limit_bytes FROM storage_usage WHERE id = 1)
BEGIN
  SELECT RAISE(IGNORE);
END;
--> statement-breakpoint
CREATE TRIGGER article_languages_storage_insert AFTER INSERT ON article_languages BEGIN
  UPDATE storage_usage SET bytes = bytes + 512 WHERE id = 1;
END;
--> statement-breakpoint
CREATE TRIGGER article_languages_storage_delete AFTER DELETE ON article_languages BEGIN
  UPDATE storage_usage SET bytes = bytes - 512 WHERE id = 1;
END;
