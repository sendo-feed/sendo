CREATE TABLE `article_activity` (
	`user_id` text NOT NULL,
	`id` text NOT NULL,
	`article_id` text NOT NULL,
	`article_title` text,
	`article_url` text,
	`occurred_at` integer NOT NULL,
	`type` text NOT NULL,
	`source` text NOT NULL,
	PRIMARY KEY(`user_id`, `id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `article_activity_user_time_idx` ON `article_activity` (`user_id`,`occurred_at`,`id`);--> statement-breakpoint
CREATE INDEX `article_activity_time_idx` ON `article_activity` (`occurred_at`);