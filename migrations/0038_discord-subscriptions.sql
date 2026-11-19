CREATE TABLE `discord_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`discord_user_id` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `discord_connections_user_id_unique` ON `discord_connections` (`user_id`);--> statement-breakpoint
DROP INDEX `feeds_url_unique`;--> statement-breakpoint
ALTER TABLE `feeds` ADD `discord_connection_id` text REFERENCES discord_connections(id);--> statement-breakpoint
ALTER TABLE `feeds` ADD `discord_cursor` text;--> statement-breakpoint
CREATE UNIQUE INDEX `feeds_public_url_idx` ON `feeds` (`url`) WHERE "feeds"."discord_cursor" is null;--> statement-breakpoint
CREATE UNIQUE INDEX `feeds_discord_connection_url_idx` ON `feeds` (`discord_connection_id`,`url`);