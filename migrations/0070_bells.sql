CREATE TABLE `bell_horizons` (
	`user_id` text PRIMARY KEY NOT NULL,
	`seq` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `bells` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`subscription_id` text,
	`created_at` integer NOT NULL,
	`deleted_at` integer,
	`seq` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`subscription_id`) REFERENCES `subscriptions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bells_user_id_subscription_id_idx` ON `bells` (`user_id`,`subscription_id`) WHERE "bells"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX `bells_subscription_id_idx` ON `bells` (`subscription_id`);--> statement-breakpoint
CREATE INDEX `bells_user_id_seq_idx` ON `bells` (`user_id`,`seq`);--> statement-breakpoint
CREATE INDEX `bells_seq_idx` ON `bells` (`seq`);--> statement-breakpoint
CREATE INDEX `bells_deleted_at_idx` ON `bells` (`deleted_at`) WHERE "bells"."deleted_at" is not null;