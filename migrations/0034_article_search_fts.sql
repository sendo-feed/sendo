-- FTS5 の仮想表と更新トリガーは drizzle-kit が扱わない。
INSERT INTO article_search_state(id) VALUES (1);
--> statement-breakpoint
CREATE VIRTUAL TABLE article_search_fts USING fts5(
  content, content='article_search_documents', content_rowid='id', tokenize='trigram'
);
--> statement-breakpoint
CREATE TRIGGER article_search_insert AFTER INSERT ON article_search_documents BEGIN
  INSERT INTO article_search_fts(rowid, content) VALUES (NEW.id, NEW.content);
  UPDATE storage_usage SET bytes = bytes + NEW.bytes WHERE id = 1;
  UPDATE article_search_state SET
    writes = CASE WHEN day = unixepoch() / 86400 THEN writes + 1 ELSE 1 END,
    day = unixepoch() / 86400
  WHERE id = 1;
  DELETE FROM article_search_pending WHERE article_id = NEW.article_id;
END;
--> statement-breakpoint
CREATE TRIGGER article_search_update AFTER UPDATE ON article_search_documents BEGIN
  INSERT INTO article_search_fts(article_search_fts, rowid, content)
    VALUES ('delete', OLD.id, OLD.content);
  INSERT INTO article_search_fts(rowid, content) VALUES (NEW.id, NEW.content);
  UPDATE storage_usage SET bytes = bytes + NEW.bytes - OLD.bytes WHERE id = 1;
  UPDATE article_search_state SET
    writes = CASE WHEN day = unixepoch() / 86400 THEN writes + 1 ELSE 1 END,
    day = unixepoch() / 86400
  WHERE id = 1;
  DELETE FROM article_search_pending WHERE article_id = NEW.article_id;
END;
--> statement-breakpoint
CREATE TRIGGER article_search_delete AFTER DELETE ON article_search_documents BEGIN
  INSERT INTO article_search_fts(article_search_fts, rowid, content)
    VALUES ('delete', OLD.id, OLD.content);
  UPDATE storage_usage SET bytes = bytes - OLD.bytes WHERE id = 1;
END;
--> statement-breakpoint
CREATE TRIGGER article_search_queue_new AFTER INSERT ON articles BEGIN
  INSERT INTO article_search_pending(article_id, queued_at)
    SELECT NEW.id, unixepoch() WHERE 1
    ON CONFLICT(article_id) DO UPDATE SET retry_at = 0, queued_at = excluded.queued_at;
END;
--> statement-breakpoint
CREATE TRIGGER article_search_queue_feed AFTER UPDATE OF content_key ON articles
WHEN OLD.content_key IS NOT NEW.content_key BEGIN
  INSERT INTO article_search_pending(article_id, queued_at)
    SELECT NEW.id, unixepoch() WHERE 1
    ON CONFLICT(article_id) DO UPDATE SET retry_at = 0, queued_at = excluded.queued_at;
END;
--> statement-breakpoint
CREATE TRIGGER article_search_queue_page AFTER INSERT ON page_contents
WHEN NEW.status = 'extracted' AND NEW.html IS NOT NULL BEGIN
  INSERT INTO article_search_pending(article_id, queued_at)
    SELECT NEW.article_id, unixepoch() WHERE 1
    ON CONFLICT(article_id) DO UPDATE SET retry_at = 0, queued_at = excluded.queued_at;
END;
--> statement-breakpoint
CREATE TRIGGER article_search_queue_page_update AFTER UPDATE OF status, html ON page_contents
WHEN (OLD.status = 'extracted' OR NEW.status = 'extracted') AND OLD.html IS NOT NEW.html BEGIN
  INSERT INTO article_search_pending(article_id, queued_at)
    SELECT NEW.article_id, unixepoch() WHERE 1
    ON CONFLICT(article_id) DO UPDATE SET retry_at = 0, queued_at = excluded.queued_at;
END;
--> statement-breakpoint
CREATE TRIGGER article_search_queue_page_delete AFTER DELETE ON page_contents
WHEN OLD.status = 'extracted' BEGIN
  INSERT INTO article_search_pending(article_id, queued_at)
    SELECT OLD.article_id, unixepoch() WHERE EXISTS (SELECT 1 FROM articles WHERE id = OLD.article_id)
    ON CONFLICT(article_id) DO UPDATE SET retry_at = 0, queued_at = excluded.queued_at;
END;
