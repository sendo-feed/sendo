ALTER TABLE `feeds` ADD `last_error_code` text;--> statement-breakpoint
ALTER TABLE `feeds` ADD `failure_started_at` integer;--> statement-breakpoint
ALTER TABLE `feeds` ADD `fetch_stalled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `feeds` ADD `relocation_candidate` text;