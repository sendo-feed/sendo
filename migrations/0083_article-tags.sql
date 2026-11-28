CREATE TABLE `article_tag_horizons` (
	`user_id` text PRIMARY KEY NOT NULL,
	`seq` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `article_tags` (
	`id` text PRIMARY KEY NOT NULL,
	`tag_id` text NOT NULL,
	`user_id` text NOT NULL,
	`article_id` text NOT NULL,
	`kind` text NOT NULL,
	`on` integer NOT NULL,
	`deleted_at` integer,
	`seq` integer NOT NULL,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `article_tags_tag_id_article_id_idx` ON `article_tags` (`tag_id`,`article_id`);--> statement-breakpoint
CREATE INDEX `article_tags_user_id_article_id_idx` ON `article_tags` (`user_id`,`article_id`);--> statement-breakpoint
CREATE INDEX `article_tags_user_id_seq_idx` ON `article_tags` (`user_id`,`seq`);--> statement-breakpoint
CREATE INDEX `article_tags_seq_idx` ON `article_tags` (`seq`);--> statement-breakpoint
CREATE INDEX `article_tags_deleted_at_idx` ON `article_tags` (`deleted_at`) WHERE "article_tags"."deleted_at" is not null;