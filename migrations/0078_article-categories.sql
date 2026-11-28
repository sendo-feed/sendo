CREATE TABLE `article_categories` (
	`article_id` text NOT NULL,
	`position` integer NOT NULL,
	`name` text NOT NULL,
	PRIMARY KEY(`article_id`, `position`),
	FOREIGN KEY (`article_id`) REFERENCES `articles`(`id`) ON UPDATE no action ON DELETE cascade
);
