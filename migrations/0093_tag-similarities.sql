CREATE TABLE `tag_similarities` (
	`tag_id` text NOT NULL,
	`user_id` text NOT NULL,
	`article_id` text NOT NULL,
	`similarity` real NOT NULL,
	PRIMARY KEY(`tag_id`, `article_id`),
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `tag_similarities_user_id_article_id_idx` ON `tag_similarities` (`user_id`,`article_id`);--> statement-breakpoint
CREATE INDEX `tag_similarities_article_id_idx` ON `tag_similarities` (`article_id`);