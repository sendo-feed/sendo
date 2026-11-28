CREATE TABLE `article_analysis_backfill` (
	`id` integer PRIMARY KEY NOT NULL,
	`cursor_created_at` integer,
	`cursor_id` text,
	`candidate_revision` integer NOT NULL,
	`embedding_revision` integer NOT NULL,
	`finished` integer NOT NULL,
	`epoch` integer DEFAULT 0 NOT NULL,
	`completed_embedding_revision` integer,
	`completed_at` integer,
	CONSTRAINT "article_analysis_backfill_single" CHECK("article_analysis_backfill"."id" = 1)
);
--> statement-breakpoint
ALTER TABLE `job_queue` ADD `slot` text;--> statement-breakpoint
CREATE UNIQUE INDEX `job_queue_slot_idx` ON `job_queue` (`slot`,("attempts" > 0));