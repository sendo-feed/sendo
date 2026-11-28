-- drizzle-kit はトリガーを扱わないので、このマイグレーションは手で書いている（drizzle-kit generate --custom で作った枠）。
--
-- 自動のタグ付けの判定待ち（docs/decisions/auto-tagging.md の 5）。判定の必要が生まれた文の中で積む。積むのは
-- 有効なタグのある人だけ。行がすでにあれば、消して入れ直し、新しい番号にする（前の番号に戻らない）。

-- 記事の埋め込みを新しい版で保存したとき（入力が空・失敗の保存を含む。候補だけを作り直したときは、埋め込みの版が
-- 変わらないので積まない）。その記事を受信箱に持つ人の行を積む
CREATE TRIGGER `article_analyses_judge_queue_insert` AFTER INSERT ON `article_analyses`
WHEN NEW.`embedding_revision` IS NOT NULL
BEGIN
  DELETE FROM `tag_judge_queue` WHERE `article_id` = NEW.`article_id` AND `user_id` IN (
    SELECT ua.`user_id` FROM `user_articles` ua WHERE ua.`article_id` = NEW.`article_id`
  );
  INSERT INTO `tag_judge_queue` (`user_id`, `article_id`)
    SELECT ua.`user_id`, NEW.`article_id` FROM `user_articles` ua
    WHERE ua.`article_id` = NEW.`article_id`
      AND EXISTS (SELECT 1 FROM `tags` t WHERE t.`user_id` = ua.`user_id` AND t.`deleted_at` IS NULL);
END;
--> statement-breakpoint
CREATE TRIGGER `article_analyses_judge_queue_update` AFTER UPDATE OF `embedding_revision` ON `article_analyses`
WHEN NEW.`embedding_revision` IS NOT NULL AND NEW.`embedding_revision` IS NOT OLD.`embedding_revision`
BEGIN
  DELETE FROM `tag_judge_queue` WHERE `article_id` = NEW.`article_id` AND `user_id` IN (
    SELECT ua.`user_id` FROM `user_articles` ua WHERE ua.`article_id` = NEW.`article_id`
  );
  INSERT INTO `tag_judge_queue` (`user_id`, `article_id`)
    SELECT ua.`user_id`, NEW.`article_id` FROM `user_articles` ua
    WHERE ua.`article_id` = NEW.`article_id`
      AND EXISTS (SELECT 1 FROM `tags` t WHERE t.`user_id` = ua.`user_id` AND t.`deleted_at` IS NULL);
END;
--> statement-breakpoint
-- 今の版（起動したときに tag_judging_revisions に書いた版）の埋め込みのある記事が受信箱に入ったとき（すでに
-- 取り込まれていたフィードを購読したときなど）
CREATE TRIGGER `user_articles_judge_queue_insert` AFTER INSERT ON `user_articles`
WHEN EXISTS (SELECT 1 FROM `tags` t WHERE t.`user_id` = NEW.`user_id` AND t.`deleted_at` IS NULL)
  AND EXISTS (
    SELECT 1 FROM `article_analyses` x JOIN `tag_judging_revisions` r ON r.`id` = 1
    WHERE x.`article_id` = NEW.`article_id` AND x.`embedding_revision` = r.`embedding_revision`
  )
BEGIN
  DELETE FROM `tag_judge_queue` WHERE `user_id` = NEW.`user_id` AND `article_id` = NEW.`article_id`;
  INSERT INTO `tag_judge_queue` (`user_id`, `article_id`) VALUES (NEW.`user_id`, NEW.`article_id`);
END;
--> statement-breakpoint
-- 手直しを取り消したとき（手で付け外しした行が、自動に戻って消した印が付いた）。取り消しでベクトルの入力が前回と
-- 同じに戻ると、判定し直しの対象のタグにならないため、取り消した記事はここで判定し直す。受信箱の削除やタグの削除の
-- 連鎖では、付け方が手のままなので当たらない
CREATE TRIGGER `article_tags_judge_queue_clear` AFTER UPDATE ON `article_tags`
WHEN OLD.`kind` = 'manual' AND OLD.`deleted_at` IS NULL AND NEW.`kind` = 'auto' AND NEW.`deleted_at` IS NOT NULL
  AND EXISTS (SELECT 1 FROM `tags` t WHERE t.`id` = NEW.`tag_id` AND t.`deleted_at` IS NULL)
  AND EXISTS (SELECT 1 FROM `user_articles` ua WHERE ua.`user_id` = NEW.`user_id` AND ua.`article_id` = NEW.`article_id`)
BEGIN
  DELETE FROM `tag_judge_queue` WHERE `user_id` = NEW.`user_id` AND `article_id` = NEW.`article_id`;
  INSERT INTO `tag_judge_queue` (`user_id`, `article_id`) VALUES (NEW.`user_id`, NEW.`article_id`);
END;
--> statement-breakpoint
-- 受信箱の行が消えたら、判定待ちの行も消す
CREATE TRIGGER `user_articles_judge_queue_delete` AFTER DELETE ON `user_articles` BEGIN
  DELETE FROM `tag_judge_queue` WHERE `user_id` = OLD.`user_id` AND `article_id` = OLD.`article_id`;
END;
