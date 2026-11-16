CREATE TABLE `content_notes` (
	`key` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `articles` ADD `content_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `articles_content_key_idx` ON `articles` (`content_key`) WHERE content_key is not null;