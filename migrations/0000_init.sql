CREATE TABLE `access_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `access_tokens_token_hash_unique` ON `access_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `access_tokens_user_id_idx` ON `access_tokens` (`user_id`);--> statement-breakpoint
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
CREATE INDEX `articles_feed_id_created_at_idx` ON `articles` (`feed_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `articles_feed_id_published_at_idx` ON `articles` (`feed_id`,`published_at`);--> statement-breakpoint
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
	`delivered_until` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `feeds_url_unique` ON `feeds` (`url`);--> statement-breakpoint
CREATE INDEX `feeds_next_fetch_at_idx` ON `feeds` (`next_fetch_at`);--> statement-breakpoint
CREATE TABLE `folders` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	`deleted_at` integer,
	`seq` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `folders_user_id_name_idx` ON `folders` (`user_id`,`name`) WHERE "folders"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX `folders_user_id_seq_idx` ON `folders` (`user_id`,`seq`);--> statement-breakpoint
CREATE INDEX `folders_seq_idx` ON `folders` (`seq`);--> statement-breakpoint
CREATE TABLE `identities` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`issuer` text NOT NULL,
	`subject` text NOT NULL,
	`email` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `identities_issuer_subject_idx` ON `identities` (`issuer`,`subject`);--> statement-breakpoint
CREATE INDEX `identities_user_id_idx` ON `identities` (`user_id`);--> statement-breakpoint
CREATE TABLE `seq_floors` (
	`table_name` text PRIMARY KEY NOT NULL,
	`floor` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`feed_id` text NOT NULL,
	`folder_id` text,
	`created_at` integer NOT NULL,
	`backfilled_at` integer,
	`deleted_at` integer,
	`seq` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`feed_id`) REFERENCES `feeds`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`folder_id`) REFERENCES `folders`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `subscriptions_user_id_feed_id_idx` ON `subscriptions` (`user_id`,`feed_id`) WHERE "subscriptions"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX `subscriptions_feed_id_idx` ON `subscriptions` (`feed_id`);--> statement-breakpoint
CREATE INDEX `subscriptions_user_id_seq_idx` ON `subscriptions` (`user_id`,`seq`);--> statement-breakpoint
CREATE INDEX `subscriptions_seq_idx` ON `subscriptions` (`seq`);--> statement-breakpoint
CREATE TABLE `user_articles` (
	`user_id` text NOT NULL,
	`article_id` text NOT NULL,
	`feed_id` text NOT NULL,
	`published_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`read_at` integer,
	`starred_at` integer,
	`seq` integer NOT NULL,
	PRIMARY KEY(`user_id`, `article_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`article_id`) REFERENCES `articles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `user_articles_user_id_published_at_idx` ON `user_articles` (`user_id`,`published_at`,`article_id`);--> statement-breakpoint
CREATE INDEX `user_articles_user_id_seq_idx` ON `user_articles` (`user_id`,`seq`);--> statement-breakpoint
CREATE INDEX `user_articles_seq_idx` ON `user_articles` (`seq`);--> statement-breakpoint
CREATE INDEX `user_articles_unread_idx` ON `user_articles` (`user_id`,`feed_id`) WHERE "user_articles"."read_at" is null;--> statement-breakpoint
CREATE INDEX `user_articles_starred_idx` ON `user_articles` (`user_id`,`starred_at`) WHERE "user_articles"."starred_at" is not null;--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);