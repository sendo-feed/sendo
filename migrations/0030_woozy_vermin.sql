CREATE TABLE `saved_page_horizons` (
	`user_id` text PRIMARY KEY NOT NULL,
	`seq` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `saved_pages` (
	`user_id` text NOT NULL,
	`id` text NOT NULL,
	`url` text,
	`title` text,
	`saved_at` integer,
	`deleted_at` integer,
	`seq` integer NOT NULL,
	PRIMARY KEY(`user_id`, `id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "saved_pages_state_check" CHECK(("saved_pages"."deleted_at" is null and "saved_pages"."url" is not null and "saved_pages"."saved_at" is not null)
        or ("saved_pages"."deleted_at" is not null and "saved_pages"."url" is null and "saved_pages"."title" is null and "saved_pages"."saved_at" is null))
);
--> statement-breakpoint
CREATE INDEX `saved_pages_seq_idx` ON `saved_pages` (`seq`);--> statement-breakpoint
CREATE INDEX `saved_pages_user_seq_idx` ON `saved_pages` (`user_id`,`seq`,`id`);--> statement-breakpoint
CREATE INDEX `saved_pages_user_saved_at_idx` ON `saved_pages` (`user_id`,`saved_at`,`id`) WHERE "saved_pages"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX `saved_pages_deleted_at_idx` ON `saved_pages` (`deleted_at`) WHERE "saved_pages"."deleted_at" is not null;