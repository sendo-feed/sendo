ALTER TABLE `article_translations` ADD `batch_key` text;--> statement-breakpoint
ALTER TABLE `article_translations` ADD `batch_marked_at` integer;--> statement-breakpoint
ALTER TABLE `article_translations` ADD `batch_id` text;--> statement-breakpoint
ALTER TABLE `article_translations` ADD `batch_content_source` text;--> statement-breakpoint
ALTER TABLE `article_translations` ADD `batch_body_hash` text;--> statement-breakpoint
CREATE INDEX `article_translations_batch_idx` ON `article_translations` (`batch_marked_at`) WHERE batch_key is not null;--> statement-breakpoint
CREATE INDEX `article_translations_batch_queue_idx` ON `article_translations` (`decided_at`,`article_id`) WHERE status = 'queued' and batch_key is null;--> statement-breakpoint
CREATE INDEX `article_translations_batch_id_idx` ON `article_translations` (`batch_id`) WHERE batch_id is not null;