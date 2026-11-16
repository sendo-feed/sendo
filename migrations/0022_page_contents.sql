CREATE TABLE `page_contents` (
	`article_id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`html` text,
	`attempted_at` integer NOT NULL,
	FOREIGN KEY (`article_id`) REFERENCES `articles`(`id`) ON UPDATE no action ON DELETE cascade
);
