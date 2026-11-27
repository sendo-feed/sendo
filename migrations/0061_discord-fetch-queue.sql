ALTER TABLE `job_queue` ADD `discord_feed_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `job_queue_discord_slot_idx` ON `job_queue` (`discord_feed_id`,("attempts" > 0));