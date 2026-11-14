ALTER TABLE `articles` ADD `read_at` integer;--> statement-breakpoint
ALTER TABLE `articles` ADD `starred_at` integer;--> statement-breakpoint
CREATE INDEX `articles_unread_feed_id_idx` ON `articles` (`feed_id`) WHERE "articles"."read_at" is null;--> statement-breakpoint
CREATE INDEX `articles_starred_at_idx` ON `articles` (`starred_at`) WHERE "articles"."starred_at" is not null;