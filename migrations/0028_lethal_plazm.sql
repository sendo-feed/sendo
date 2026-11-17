ALTER TABLE `storage_usage` ADD `reclaim_token` text;--> statement-breakpoint
ALTER TABLE `storage_usage` ADD `reclaim_until` integer DEFAULT 0 NOT NULL;