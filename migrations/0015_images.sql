CREATE TABLE `app_secrets` (
	`name` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `articles` ADD `thumbnail_url` text;--> statement-breakpoint
ALTER TABLE `feeds` ADD `icon_url` text;--> statement-breakpoint
ALTER TABLE `feeds` ADD `icon_checked_at` integer;