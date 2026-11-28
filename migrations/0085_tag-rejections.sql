CREATE TABLE `tag_rejections` (
	`user_id` text NOT NULL,
	`key` text NOT NULL,
	`rejected_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `key`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `tag_rejections_user_id_rejected_at_idx` ON `tag_rejections` (`user_id`,`rejected_at`);