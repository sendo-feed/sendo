-- drizzle-kit はトリガーを扱わないので、このマイグレーションは手で書いている（drizzle-kit generate --custom で作った枠）。
--
-- 人ごとのタグの版（docs/decisions/auto-tagging.md の 4）。タグの API と手の付け外しの API で行が実際に変わった
-- ときに、同じ文の中で版を上げ、判定し直しの位置を先頭に戻す。自動の書き込みと、受信箱の削除やタグの削除で
-- 付く消した印では上げない。

-- タグを作ったとき
CREATE TRIGGER `tags_judging_insert` AFTER INSERT ON `tags`
WHEN NEW.`deleted_at` IS NULL
BEGIN
  INSERT INTO `tag_judging` (`user_id`, `revision`, `revised_at`, `cursor_created_at`, `cursor_article_id`, `finished`, `cursor_moved_at`)
    VALUES (NEW.`user_id`, 1, cast(unixepoch('subsec') * 1000 as integer), NULL, NULL, 0, cast(unixepoch('subsec') * 1000 as integer))
    ON CONFLICT (`user_id`) DO UPDATE SET
      `revision` = `revision` + 1, `revised_at` = excluded.`revised_at`,
      `cursor_created_at` = NULL, `cursor_article_id` = NULL, `finished` = 0,
      `cursor_moved_at` = excluded.`cursor_moved_at`;
END;
--> statement-breakpoint
-- 有効なタグの名前か説明が変わったとき、タグを消したとき（値の変わらない変更では上げない）
CREATE TRIGGER `tags_judging_update` AFTER UPDATE OF `name`, `description`, `deleted_at` ON `tags`
WHEN OLD.`deleted_at` IS NULL AND (
  NEW.`deleted_at` IS NOT NULL OR OLD.`name` IS NOT NEW.`name` OR OLD.`description` IS NOT NEW.`description`
)
BEGIN
  INSERT INTO `tag_judging` (`user_id`, `revision`, `revised_at`, `cursor_created_at`, `cursor_article_id`, `finished`, `cursor_moved_at`)
    VALUES (NEW.`user_id`, 1, cast(unixepoch('subsec') * 1000 as integer), NULL, NULL, 0, cast(unixepoch('subsec') * 1000 as integer))
    ON CONFLICT (`user_id`) DO UPDATE SET
      `revision` = `revision` + 1, `revised_at` = excluded.`revised_at`,
      `cursor_created_at` = NULL, `cursor_article_id` = NULL, `finished` = 0,
      `cursor_moved_at` = excluded.`cursor_moved_at`;
END;
--> statement-breakpoint
-- タグに消した印が付いたら、名前と説明の埋め込みとベクトルを空にする（docs/decisions/auto-tagging.md の 1）
CREATE TRIGGER `tags_judging_clear_vector` AFTER UPDATE OF `deleted_at` ON `tags`
WHEN OLD.`deleted_at` IS NULL AND NEW.`deleted_at` IS NOT NULL
BEGIN
  UPDATE `tags` SET `name_embedding_input` = NULL, `name_embedding` = NULL, `vector` = NULL
  WHERE `id` = NEW.`id`;
END;
--> statement-breakpoint
-- 手で付けた ／ 外した行を作ったとき
CREATE TRIGGER `article_tags_judging_insert` AFTER INSERT ON `article_tags`
WHEN NEW.`kind` = 'manual' AND NEW.`deleted_at` IS NULL
BEGIN
  INSERT INTO `tag_judging` (`user_id`, `revision`, `revised_at`, `cursor_created_at`, `cursor_article_id`, `finished`, `cursor_moved_at`)
    VALUES (NEW.`user_id`, 1, cast(unixepoch('subsec') * 1000 as integer), NULL, NULL, 0, cast(unixepoch('subsec') * 1000 as integer))
    ON CONFLICT (`user_id`) DO UPDATE SET
      `revision` = `revision` + 1, `revised_at` = excluded.`revised_at`,
      `cursor_created_at` = NULL, `cursor_article_id` = NULL, `finished` = 0,
      `cursor_moved_at` = excluded.`cursor_moved_at`;
END;
--> statement-breakpoint
-- 手直しの見える状態（手で付けた ／ 手で外した ／ 手直しなし）が変わったとき。タグの削除の連鎖（タグが有効で
-- ない）と、受信箱の削除の連鎖（受信箱の行がもうない）では上げない。自動の書き込みは手直しの行を変えないので
-- 当たらない
CREATE TRIGGER `article_tags_judging_update` AFTER UPDATE ON `article_tags`
WHEN (
  ((OLD.`kind` = 'manual' AND OLD.`deleted_at` IS NULL) != (NEW.`kind` = 'manual' AND NEW.`deleted_at` IS NULL))
  OR (OLD.`kind` = 'manual' AND OLD.`deleted_at` IS NULL AND NEW.`kind` = 'manual' AND NEW.`deleted_at` IS NULL
    AND OLD.`on` != NEW.`on`)
)
AND EXISTS (SELECT 1 FROM `tags` WHERE `id` = NEW.`tag_id` AND `deleted_at` IS NULL)
AND EXISTS (SELECT 1 FROM `user_articles` WHERE `user_id` = NEW.`user_id` AND `article_id` = NEW.`article_id`)
BEGIN
  INSERT INTO `tag_judging` (`user_id`, `revision`, `revised_at`, `cursor_created_at`, `cursor_article_id`, `finished`, `cursor_moved_at`)
    VALUES (NEW.`user_id`, 1, cast(unixepoch('subsec') * 1000 as integer), NULL, NULL, 0, cast(unixepoch('subsec') * 1000 as integer))
    ON CONFLICT (`user_id`) DO UPDATE SET
      `revision` = `revision` + 1, `revised_at` = excluded.`revised_at`,
      `cursor_created_at` = NULL, `cursor_article_id` = NULL, `finished` = 0,
      `cursor_moved_at` = excluded.`cursor_moved_at`;
END;
