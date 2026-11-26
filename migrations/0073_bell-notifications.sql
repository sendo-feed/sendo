CREATE TABLE `bell_notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`bell_id` text NOT NULL,
	`article_id` text,
	`window_start` integer NOT NULL,
	`created_at` integer NOT NULL,
	`state` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`bell_id`) REFERENCES `bells`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`article_id`) REFERENCES `articles`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "bell_notifications_state_check" CHECK("bell_notifications"."state" in ('sent', 'limited', 'bundled')
        and ("bell_notifications"."state" <> 'bundled' or "bell_notifications"."article_id" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bell_notifications_article_id_user_id_idx` ON `bell_notifications` (`article_id`,`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `bell_notifications_bundle_idx` ON `bell_notifications` (`user_id`,`bell_id`,`window_start`) WHERE "bell_notifications"."article_id" is null;--> statement-breakpoint
CREATE INDEX `bell_notifications_bell_id_window_start_idx` ON `bell_notifications` (`bell_id`,`window_start`);--> statement-breakpoint
CREATE INDEX `bell_notifications_user_id_created_at_idx` ON `bell_notifications` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `bell_notifications_bundled_idx` ON `bell_notifications` (`window_start`) WHERE "bell_notifications"."state" = 'bundled';--> statement-breakpoint
CREATE INDEX `bell_notifications_created_at_idx` ON `bell_notifications` (`created_at`);