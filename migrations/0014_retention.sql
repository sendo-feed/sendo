CREATE TABLE `sync_horizons` (
	`table_name` text PRIMARY KEY NOT NULL,
	`seq` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `feeds` ADD `cleaned_until` integer;--> statement-breakpoint
CREATE INDEX `user_articles_article_id_idx` ON `user_articles` (`article_id`);