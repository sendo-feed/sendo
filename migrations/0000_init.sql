CREATE TABLE `articles` (
	`id` text PRIMARY KEY NOT NULL,
	`feed_id` text NOT NULL,
	`guid` text NOT NULL,
	`url` text,
	`title` text,
	`summary` text,
	`author` text,
	`published_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`feed_id`) REFERENCES `feeds`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `articles_feed_id_guid_idx` ON `articles` (`feed_id`,`guid`);--> statement-breakpoint
CREATE INDEX `articles_published_at_id_idx` ON `articles` (`published_at`,`id`);--> statement-breakpoint
CREATE INDEX `articles_feed_id_published_at_id_idx` ON `articles` (`feed_id`,`published_at`,`id`);--> statement-breakpoint
CREATE TABLE `feeds` (
	`id` text PRIMARY KEY NOT NULL,
	`url` text NOT NULL,
	`title` text,
	`site_url` text,
	`etag` text,
	`last_modified` text,
	`last_fetched_at` integer,
	`next_fetch_at` integer NOT NULL,
	`error_count` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `feeds_url_unique` ON `feeds` (`url`);--> statement-breakpoint
CREATE INDEX `feeds_next_fetch_at_idx` ON `feeds` (`next_fetch_at`);