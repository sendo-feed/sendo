-- drizzle-kit はトリガーを扱わないので、このマイグレーションは手で書いている（drizzle-kit generate --custom で作った枠）。
--
-- 手で付け外しした記事に、埋め込みが初めて入ったとき（前の版の埋め込みがなかったとき）、その記事に手直しのある
-- 人のタグの版を上げ、判定し直しの位置を先頭に戻す（docs/decisions/auto-tagging.md の 4）。手直しは、タグが
-- 有効で、記事が受信箱にあるものだけ。解析し直しで埋め込みの版が変わっただけでは上げない。
-- 受信箱の行（記事の ID の索引）から引き、記事のタグは (user_id, article_id) の索引で引く（記事のタグの表には
-- 記事の ID から始まる索引がないため）

CREATE TRIGGER `article_analyses_judging_insert` AFTER INSERT ON `article_analyses`
WHEN NEW.`embedding` IS NOT NULL
BEGIN
  INSERT INTO `tag_judging` (`user_id`, `revision`, `revised_at`, `cursor_created_at`, `cursor_article_id`, `finished`, `cursor_moved_at`)
    SELECT DISTINCT g.`user_id`, 1, cast(unixepoch('subsec') * 1000 as integer), NULL, NULL, 0, cast(unixepoch('subsec') * 1000 as integer)
    FROM `user_articles` ua
    JOIN `article_tags` g ON g.`user_id` = ua.`user_id` AND g.`article_id` = ua.`article_id`
    WHERE ua.`article_id` = NEW.`article_id` AND g.`kind` = 'manual' AND g.`deleted_at` IS NULL
      AND EXISTS (SELECT 1 FROM `tags` t WHERE t.`id` = g.`tag_id` AND t.`deleted_at` IS NULL)
    ON CONFLICT (`user_id`) DO UPDATE SET
      `revision` = `revision` + 1, `revised_at` = excluded.`revised_at`,
      `cursor_created_at` = NULL, `cursor_article_id` = NULL, `finished` = 0,
      `cursor_moved_at` = excluded.`cursor_moved_at`;
END;
--> statement-breakpoint
CREATE TRIGGER `article_analyses_judging_update` AFTER UPDATE OF `embedding` ON `article_analyses`
WHEN OLD.`embedding` IS NULL AND NEW.`embedding` IS NOT NULL
BEGIN
  INSERT INTO `tag_judging` (`user_id`, `revision`, `revised_at`, `cursor_created_at`, `cursor_article_id`, `finished`, `cursor_moved_at`)
    SELECT DISTINCT g.`user_id`, 1, cast(unixepoch('subsec') * 1000 as integer), NULL, NULL, 0, cast(unixepoch('subsec') * 1000 as integer)
    FROM `user_articles` ua
    JOIN `article_tags` g ON g.`user_id` = ua.`user_id` AND g.`article_id` = ua.`article_id`
    WHERE ua.`article_id` = NEW.`article_id` AND g.`kind` = 'manual' AND g.`deleted_at` IS NULL
      AND EXISTS (SELECT 1 FROM `tags` t WHERE t.`id` = g.`tag_id` AND t.`deleted_at` IS NULL)
    ON CONFLICT (`user_id`) DO UPDATE SET
      `revision` = `revision` + 1, `revised_at` = excluded.`revised_at`,
      `cursor_created_at` = NULL, `cursor_article_id` = NULL, `finished` = 0,
      `cursor_moved_at` = excluded.`cursor_moved_at`;
END;
