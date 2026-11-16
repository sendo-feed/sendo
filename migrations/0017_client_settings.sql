CREATE TABLE `client_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`device_type` text NOT NULL,
	`name` text NOT NULL,
	`value` text,
	`size` integer NOT NULL,
	`seq` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `client_settings_user_id_device_type_name_idx` ON `client_settings` (`user_id`,`device_type`,`name`);--> statement-breakpoint
CREATE INDEX `client_settings_user_id_seq_idx` ON `client_settings` (`user_id`,`seq`);--> statement-breakpoint
CREATE TABLE `setting_horizons` (
	`user_id` text PRIMARY KEY NOT NULL,
	`seq` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
