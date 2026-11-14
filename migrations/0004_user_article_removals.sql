CREATE TABLE `user_article_removals` (
	`user_id` text NOT NULL,
	`article_id` text NOT NULL,
	`seq` integer NOT NULL,
	`removed_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `article_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `user_article_removals_user_id_seq_idx` ON `user_article_removals` (`user_id`,`seq`);