CREATE TABLE `content_sizes` (
	`key` text PRIMARY KEY NOT NULL,
	`bytes` integer,
	`article_bytes` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `content_sizes_unmeasured_idx` ON `content_sizes` (`bytes`) WHERE bytes is null;--> statement-breakpoint
CREATE TABLE `storage_usage` (
	`id` integer PRIMARY KEY NOT NULL,
	`bytes` integer DEFAULT 0 NOT NULL,
	`limit_bytes` integer DEFAULT 268435456 NOT NULL,
	`reclaiming` integer DEFAULT false NOT NULL,
	`eviction_day` integer DEFAULT -1 NOT NULL,
	`eviction_batches` integer DEFAULT 0 NOT NULL,
	`reclaim_token` text,
	`reclaim_until` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE `articles` ADD `in_current_feed` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `articles` ADD `reserved_inbox_bytes` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `articles_created_at_id_idx` ON `articles` (`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `articles_feed_id_current_idx` ON `articles` (`feed_id`,`in_current_feed`);--> statement-breakpoint
ALTER TABLE `feeds` DROP COLUMN `cleaned_until`;