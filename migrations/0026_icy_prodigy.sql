ALTER TABLE `storage_usage` ADD `reclaiming` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `storage_usage` ADD `eviction_day` integer DEFAULT -1 NOT NULL;--> statement-breakpoint
ALTER TABLE `storage_usage` ADD `eviction_batches` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `content_sizes_unmeasured_idx` ON `content_sizes` (`bytes`) WHERE bytes is null;