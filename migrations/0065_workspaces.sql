CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	`deleted_at` integer,
	`seq` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspaces_user_id_name_idx` ON `workspaces` (`user_id`,`name`) WHERE "workspaces"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX `workspaces_user_id_seq_idx` ON `workspaces` (`user_id`,`seq`);--> statement-breakpoint
CREATE INDEX `workspaces_seq_idx` ON `workspaces` (`seq`);--> statement-breakpoint
ALTER TABLE `subscriptions` ADD `workspace_id` text REFERENCES workspaces(id);--> statement-breakpoint
CREATE INDEX `subscriptions_active_workspace_idx` ON `subscriptions` (`user_id`,`workspace_id`) WHERE "subscriptions"."deleted_at" is null;