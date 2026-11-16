CREATE TABLE `job_queue` (
	`id` text PRIMARY KEY NOT NULL,
	`job` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`run_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `job_queue_run_at_idx` ON `job_queue` (`run_at`);