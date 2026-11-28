CREATE TABLE `tag_horizons` (
	`user_id` text PRIMARY KEY NOT NULL,
	`seq` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `tags` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`match_key` text NOT NULL,
	`description` text NOT NULL,
	`created_at` integer NOT NULL,
	`deleted_at` integer,
	`seq` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tags_user_id_match_key_idx` ON `tags` (`user_id`,`match_key`) WHERE "tags"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX `tags_user_id_seq_idx` ON `tags` (`user_id`,`seq`);--> statement-breakpoint
CREATE INDEX `tags_seq_idx` ON `tags` (`seq`);--> statement-breakpoint
CREATE INDEX `tags_deleted_at_idx` ON `tags` (`deleted_at`) WHERE "tags"."deleted_at" is not null;