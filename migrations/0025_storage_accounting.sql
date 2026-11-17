-- drizzle-kit generate --custom の枠。行と索引の分は docs/decisions/retention.md の見積もり。
INSERT INTO content_sizes (key, bytes) SELECT content_key, NULL FROM articles WHERE content_key IS NOT NULL ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO content_sizes (key, bytes) SELECT key, NULL FROM content_notes WHERE true ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO storage_usage (id, bytes) VALUES (1, (SELECT coalesce(sum(2048 + coalesce(length(cast(id as blob)), 0) + coalesce(length(cast(feed_id as blob)), 0) + coalesce(length(cast(guid as blob)), 0) + coalesce(length(cast(url as blob)), 0) + coalesce(length(cast(title as blob)), 0) + coalesce(length(cast(summary as blob)), 0) + coalesce(length(cast(author as blob)), 0) + coalesce(length(cast(thumbnail_url as blob)), 0) + coalesce(length(cast(content_key as blob)), 0)), 0) FROM articles) + (SELECT coalesce(sum(512), 0) FROM user_articles) + (SELECT coalesce(sum(256), 0) FROM user_article_removals) + (SELECT coalesce(sum(256 + coalesce(length(cast(html as blob)), 0)), 0) FROM page_contents) + (SELECT coalesce(sum(256 + coalesce(bytes, 0)), 0) FROM content_sizes));

--> statement-breakpoint
CREATE TRIGGER articles_reserve_delivery AFTER INSERT ON articles
WHEN EXISTS (SELECT 1 FROM subscriptions WHERE feed_id = NEW.feed_id AND deleted_at IS NULL)
BEGIN
  UPDATE articles SET reserved_inbox_bytes = 512 * (
    SELECT count(*) FROM subscriptions WHERE feed_id = NEW.feed_id AND deleted_at IS NULL
  ) WHERE id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER articles_storage_admission BEFORE INSERT ON articles
WHEN NOT EXISTS (SELECT 1 FROM articles WHERE feed_id = NEW.feed_id AND guid = NEW.guid)
BEGIN
  UPDATE content_sizes SET article_bytes = 0 WHERE key = NEW.content_key AND article_bytes > 0;
  SELECT CASE WHEN (SELECT bytes + (2048 + coalesce(length(cast(NEW.id as blob)), 0) + coalesce(length(cast(NEW.feed_id as blob)), 0) + coalesce(length(cast(NEW.guid as blob)), 0) + coalesce(length(cast(NEW.url as blob)), 0) + coalesce(length(cast(NEW.title as blob)), 0) + coalesce(length(cast(NEW.summary as blob)), 0) + coalesce(length(cast(NEW.author as blob)), 0) + coalesce(length(cast(NEW.thumbnail_url as blob)), 0) + coalesce(length(cast(NEW.content_key as blob)), 0) + NEW.reserved_inbox_bytes)
    + 512 * (SELECT count(*) FROM subscriptions WHERE feed_id = NEW.feed_id AND deleted_at IS NULL)
    > limit_bytes FROM storage_usage WHERE id = 1) THEN RAISE(IGNORE) END;
END;
--> statement-breakpoint
CREATE TRIGGER articles_storage_delete AFTER DELETE ON articles BEGIN
  UPDATE storage_usage SET bytes = bytes - (2048 + coalesce(length(cast(OLD.id as blob)), 0) + coalesce(length(cast(OLD.feed_id as blob)), 0) + coalesce(length(cast(OLD.guid as blob)), 0) + coalesce(length(cast(OLD.url as blob)), 0) + coalesce(length(cast(OLD.title as blob)), 0) + coalesce(length(cast(OLD.summary as blob)), 0) + coalesce(length(cast(OLD.author as blob)), 0) + coalesce(length(cast(OLD.thumbnail_url as blob)), 0) + coalesce(length(cast(OLD.content_key as blob)), 0) + OLD.reserved_inbox_bytes) WHERE id = 1;
END;
--> statement-breakpoint
CREATE TRIGGER articles_storage_insert AFTER INSERT ON articles BEGIN
  UPDATE storage_usage SET bytes = bytes + (2048 + coalesce(length(cast(NEW.id as blob)), 0) + coalesce(length(cast(NEW.feed_id as blob)), 0) + coalesce(length(cast(NEW.guid as blob)), 0) + coalesce(length(cast(NEW.url as blob)), 0) + coalesce(length(cast(NEW.title as blob)), 0) + coalesce(length(cast(NEW.summary as blob)), 0) + coalesce(length(cast(NEW.author as blob)), 0) + coalesce(length(cast(NEW.thumbnail_url as blob)), 0) + coalesce(length(cast(NEW.content_key as blob)), 0) + NEW.reserved_inbox_bytes) WHERE id = 1;
END;
--> statement-breakpoint
CREATE TRIGGER articles_storage_update AFTER UPDATE ON articles
WHEN (2048 + coalesce(length(cast(NEW.id as blob)), 0) + coalesce(length(cast(NEW.feed_id as blob)), 0) + coalesce(length(cast(NEW.guid as blob)), 0) + coalesce(length(cast(NEW.url as blob)), 0) + coalesce(length(cast(NEW.title as blob)), 0) + coalesce(length(cast(NEW.summary as blob)), 0) + coalesce(length(cast(NEW.author as blob)), 0) + coalesce(length(cast(NEW.thumbnail_url as blob)), 0) + coalesce(length(cast(NEW.content_key as blob)), 0) + NEW.reserved_inbox_bytes) != (2048 + coalesce(length(cast(OLD.id as blob)), 0) + coalesce(length(cast(OLD.feed_id as blob)), 0) + coalesce(length(cast(OLD.guid as blob)), 0) + coalesce(length(cast(OLD.url as blob)), 0) + coalesce(length(cast(OLD.title as blob)), 0) + coalesce(length(cast(OLD.summary as blob)), 0) + coalesce(length(cast(OLD.author as blob)), 0) + coalesce(length(cast(OLD.thumbnail_url as blob)), 0) + coalesce(length(cast(OLD.content_key as blob)), 0) + OLD.reserved_inbox_bytes) BEGIN
  UPDATE storage_usage SET bytes = bytes + (2048 + coalesce(length(cast(NEW.id as blob)), 0) + coalesce(length(cast(NEW.feed_id as blob)), 0) + coalesce(length(cast(NEW.guid as blob)), 0) + coalesce(length(cast(NEW.url as blob)), 0) + coalesce(length(cast(NEW.title as blob)), 0) + coalesce(length(cast(NEW.summary as blob)), 0) + coalesce(length(cast(NEW.author as blob)), 0) + coalesce(length(cast(NEW.thumbnail_url as blob)), 0) + coalesce(length(cast(NEW.content_key as blob)), 0) + NEW.reserved_inbox_bytes) - (2048 + coalesce(length(cast(OLD.id as blob)), 0) + coalesce(length(cast(OLD.feed_id as blob)), 0) + coalesce(length(cast(OLD.guid as blob)), 0) + coalesce(length(cast(OLD.url as blob)), 0) + coalesce(length(cast(OLD.title as blob)), 0) + coalesce(length(cast(OLD.summary as blob)), 0) + coalesce(length(cast(OLD.author as blob)), 0) + coalesce(length(cast(OLD.thumbnail_url as blob)), 0) + coalesce(length(cast(OLD.content_key as blob)), 0) + OLD.reserved_inbox_bytes) WHERE id = 1;
END;
--> statement-breakpoint
CREATE TRIGGER content_sizes_storage_admission BEFORE INSERT ON content_sizes
WHEN (SELECT bytes + (256 + coalesce(NEW.bytes, 0) + NEW.article_bytes) > limit_bytes FROM storage_usage WHERE id = 1)
BEGIN
  SELECT RAISE(IGNORE);
END;
--> statement-breakpoint
CREATE TRIGGER content_sizes_storage_delete AFTER DELETE ON content_sizes BEGIN
  UPDATE storage_usage SET bytes = bytes - (256 + coalesce(OLD.bytes, 0) + OLD.article_bytes) WHERE id = 1;
END;
--> statement-breakpoint
CREATE TRIGGER content_sizes_storage_insert AFTER INSERT ON content_sizes BEGIN
  UPDATE storage_usage SET bytes = bytes + (256 + coalesce(NEW.bytes, 0) + NEW.article_bytes) WHERE id = 1;
END;
--> statement-breakpoint
CREATE TRIGGER content_sizes_storage_update AFTER UPDATE ON content_sizes
WHEN (256 + coalesce(NEW.bytes, 0) + NEW.article_bytes) != (256 + coalesce(OLD.bytes, 0) + OLD.article_bytes) BEGIN
  UPDATE storage_usage SET bytes = bytes + (256 + coalesce(NEW.bytes, 0) + NEW.article_bytes) - (256 + coalesce(OLD.bytes, 0) + OLD.article_bytes) WHERE id = 1;
END;
--> statement-breakpoint
CREATE TRIGGER feeds_release_delivery AFTER UPDATE OF delivered_until ON feeds
WHEN NEW.delivered_until IS NOT NULL
BEGIN
  UPDATE articles SET reserved_inbox_bytes = 0
  WHERE feed_id = NEW.id AND reserved_inbox_bytes > 0 AND created_at <= NEW.delivered_until + 1
    AND NOT EXISTS (
      SELECT 1 FROM subscriptions s WHERE s.feed_id = NEW.id AND s.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM user_articles u
          WHERE u.article_id = articles.id AND u.user_id = s.user_id)
    );
END;
--> statement-breakpoint
CREATE TRIGGER page_contents_storage_admission BEFORE INSERT ON page_contents
WHEN NOT EXISTS (SELECT 1 FROM page_contents WHERE article_id = NEW.article_id)
  AND (SELECT bytes + (256 + coalesce(length(cast(NEW.html as blob)), 0)) > limit_bytes FROM storage_usage WHERE id = 1)
BEGIN
  SELECT RAISE(IGNORE);
END;
--> statement-breakpoint
CREATE TRIGGER page_contents_storage_delete AFTER DELETE ON page_contents BEGIN
  UPDATE storage_usage SET bytes = bytes + (-(256 + coalesce(length(cast(OLD.html as blob)), 0))) WHERE id = 1;
END;
--> statement-breakpoint
CREATE TRIGGER page_contents_storage_insert AFTER INSERT ON page_contents BEGIN
  UPDATE storage_usage SET bytes = bytes + (256 + coalesce(length(cast(NEW.html as blob)), 0)) WHERE id = 1;
END;
--> statement-breakpoint
CREATE TRIGGER page_contents_storage_update AFTER UPDATE ON page_contents
WHEN ((256 + coalesce(length(cast(NEW.html as blob)), 0)) - (256 + coalesce(length(cast(OLD.html as blob)), 0))) != 0 BEGIN
  UPDATE storage_usage SET bytes = bytes + ((256 + coalesce(length(cast(NEW.html as blob)), 0)) - (256 + coalesce(length(cast(OLD.html as blob)), 0))) WHERE id = 1;
END;
--> statement-breakpoint
CREATE TRIGGER page_contents_storage_update_admission BEFORE UPDATE ON page_contents
WHEN (SELECT bytes + coalesce(length(cast(NEW.html as blob)), 0) - coalesce(length(cast(OLD.html as blob)), 0) > limit_bytes FROM storage_usage WHERE id = 1)
BEGIN
  SELECT RAISE(IGNORE);
END;
--> statement-breakpoint
CREATE TRIGGER user_article_removals_storage_delete AFTER DELETE ON user_article_removals BEGIN
  UPDATE storage_usage SET bytes = bytes + (-(256)) WHERE id = 1;
END;
--> statement-breakpoint
CREATE TRIGGER user_article_removals_storage_insert AFTER INSERT ON user_article_removals BEGIN
  UPDATE storage_usage SET bytes = bytes + (256) WHERE id = 1;
END;
--> statement-breakpoint
CREATE TRIGGER user_article_removals_storage_update AFTER UPDATE ON user_article_removals
WHEN ((256) - (256)) != 0 BEGIN
  UPDATE storage_usage SET bytes = bytes + ((256) - (256)) WHERE id = 1;
END;
--> statement-breakpoint
CREATE TRIGGER user_articles_storage_admission BEFORE INSERT ON user_articles
WHEN NOT EXISTS (SELECT 1 FROM user_articles WHERE user_id = NEW.user_id AND article_id = NEW.article_id)
BEGIN
  UPDATE articles SET reserved_inbox_bytes = reserved_inbox_bytes - 512
    WHERE id = NEW.article_id AND reserved_inbox_bytes >= 512;
  SELECT CASE WHEN (SELECT bytes + 512 > limit_bytes FROM storage_usage WHERE id = 1)
    THEN RAISE(ABORT, 'SENDO_STORAGE_LIMIT') END;
END;
--> statement-breakpoint
CREATE TRIGGER user_articles_storage_delete AFTER DELETE ON user_articles BEGIN
  UPDATE storage_usage SET bytes = bytes + (-(512)) WHERE id = 1;
END;
--> statement-breakpoint
CREATE TRIGGER user_articles_storage_insert AFTER INSERT ON user_articles BEGIN
  UPDATE storage_usage SET bytes = bytes + (512) WHERE id = 1;
END;
--> statement-breakpoint
CREATE TRIGGER user_articles_storage_update AFTER UPDATE ON user_articles
WHEN ((512) - (512)) != 0 BEGIN
  UPDATE storage_usage SET bytes = bytes + ((512) - (512)) WHERE id = 1;
END;
