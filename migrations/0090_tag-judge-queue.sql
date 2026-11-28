CREATE TABLE `tag_judge_queue` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`article_id` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tag_judge_queue_user_id_article_id_idx` ON `tag_judge_queue` (`user_id`,`article_id`);--> statement-breakpoint
CREATE INDEX `tag_judge_queue_user_id_id_idx` ON `tag_judge_queue` (`user_id`,`id`);--> statement-breakpoint
CREATE TABLE `tag_judging_revisions` (
	`id` integer PRIMARY KEY NOT NULL,
	`judge_revision` integer NOT NULL,
	`embedding_revision` integer NOT NULL
);
