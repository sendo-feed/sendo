CREATE TABLE `article_search_documents` (
	`id` integer PRIMARY KEY NOT NULL,
	`article_id` text NOT NULL,
	`revision` text NOT NULL,
	`content` text NOT NULL,
	`bytes` integer NOT NULL,
	FOREIGN KEY (`article_id`) REFERENCES `articles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `article_search_documents_article_id_unique` ON `article_search_documents` (`article_id`);--> statement-breakpoint
CREATE TABLE `article_search_pending` (
	`article_id` text PRIMARY KEY NOT NULL,
	`retry_at` integer DEFAULT 0 NOT NULL,
	`queued_at` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`article_id`) REFERENCES `articles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `article_search_pending_order_idx` ON `article_search_pending` (`retry_at`,"queued_at" desc,`article_id`);--> statement-breakpoint
CREATE TABLE `article_search_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`day` integer DEFAULT -1 NOT NULL,
	`writes` integer DEFAULT 0 NOT NULL,
	`backfill_after` text,
	`backfill_done` integer DEFAULT false NOT NULL
);
