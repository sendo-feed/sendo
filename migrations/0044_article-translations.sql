CREATE TABLE `article_translations` (
	`article_id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`language` text NOT NULL,
	`title` text,
	`summary` text,
	`model` text,
	`translated_at` integer,
	`started_at` integer,
	`attempts` integer DEFAULT 0 NOT NULL,
	`decided_at` integer NOT NULL,
	FOREIGN KEY (`article_id`) REFERENCES `articles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `article_translations_translating_idx` ON `article_translations` (`started_at`) WHERE status = 'translating';