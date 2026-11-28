CREATE TABLE `article_analyses` (
	`article_id` text PRIMARY KEY NOT NULL,
	`feed_id` text NOT NULL,
	`summary_hash` text,
	`candidate_revision` integer,
	`candidate_status` text,
	`candidate_generation` text,
	`embedding_revision` integer,
	`embedding_status` text,
	`embedding` blob,
	`analyzed_at` integer NOT NULL,
	FOREIGN KEY (`article_id`) REFERENCES `articles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `article_analyses_feed_id_summary_hash_idx` ON `article_analyses` (`feed_id`,`summary_hash`) WHERE "article_analyses"."summary_hash" is not null;--> statement-breakpoint
CREATE TABLE `article_candidates` (
	`article_id` text NOT NULL,
	`generation` text NOT NULL,
	`key` text NOT NULL,
	`surface` text NOT NULL,
	`source` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`article_id`, `generation`, `key`),
	FOREIGN KEY (`article_id`) REFERENCES `articles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `article_candidates_created_at_idx` ON `article_candidates` (`created_at`);