CREATE TABLE `content_sizes` (
	`key` text PRIMARY KEY NOT NULL,
	`bytes` integer
);
--> statement-breakpoint
CREATE TABLE `storage_usage` (
	`id` integer PRIMARY KEY NOT NULL,
	`bytes` integer DEFAULT 0 NOT NULL,
	`limit_bytes` integer DEFAULT 268435456 NOT NULL
);
--> statement-breakpoint
ALTER TABLE `articles` ADD `in_current_feed` integer DEFAULT true NOT NULL;--> statement-breakpoint
CREATE INDEX `articles_created_at_id_idx` ON `articles` (`created_at`,`id`);--> statement-breakpoint
ALTER TABLE `feeds` DROP COLUMN `cleaned_until`;