CREATE TABLE `removal_horizons` (
	`user_id` text PRIMARY KEY NOT NULL,
	`seq` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `feeds` ADD `cleaned_until` integer;--> statement-breakpoint
CREATE INDEX `user_articles_article_id_idx` ON `user_articles` (`article_id`);