DROP INDEX `bells_user_id_subscription_id_idx`;--> statement-breakpoint
ALTER TABLE `bells` ADD `words` text;--> statement-breakpoint
ALTER TABLE `bells` ADD `match_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `bells_user_id_subscription_id_match_key_idx` ON `bells` (`user_id`,(case when "subscription_id" is null then '' else "subscription_id" end),(case when "match_key" is null then '' else "match_key" end)) WHERE "bells"."deleted_at" is null;