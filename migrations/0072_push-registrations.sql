CREATE TABLE `push_registrations` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`session_id` text NOT NULL,
	`endpoint` text NOT NULL,
	`p256dh` text NOT NULL,
	`auth` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `push_registrations_session_id_idx` ON `push_registrations` (`session_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `push_registrations_endpoint_idx` ON `push_registrations` (`endpoint`);--> statement-breakpoint
CREATE INDEX `push_registrations_user_id_idx` ON `push_registrations` (`user_id`);