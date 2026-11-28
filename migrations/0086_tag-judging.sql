CREATE TABLE `tag_judging` (
	`user_id` text PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL,
	`revised_at` integer NOT NULL,
	`cursor_created_at` integer,
	`cursor_article_id` text,
	`finished` integer NOT NULL,
	`cursor_moved_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `tags` ADD `name_embedding_input` text;--> statement-breakpoint
ALTER TABLE `tags` ADD `name_embedding` blob;--> statement-breakpoint
ALTER TABLE `tags` ADD `vector` blob;--> statement-breakpoint
ALTER TABLE `tags` ADD `vector_tag_revision` integer;--> statement-breakpoint
ALTER TABLE `tags` ADD `vector_embedding_revision` integer;--> statement-breakpoint
ALTER TABLE `tags` ADD `vector_judge_revision` integer;--> statement-breakpoint
ALTER TABLE `tags` ADD `vector_started_at` integer;--> statement-breakpoint
ALTER TABLE `tags` ADD `stats_mean` real;--> statement-breakpoint
ALTER TABLE `tags` ADD `stats_std_dev` real;--> statement-breakpoint
ALTER TABLE `tags` ADD `stats_count` integer;--> statement-breakpoint
CREATE INDEX `user_articles_user_id_created_at_idx` ON `user_articles` (`user_id`,`created_at`,`article_id`);