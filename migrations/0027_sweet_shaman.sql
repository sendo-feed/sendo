CREATE TABLE `article_languages` (
	`article_id` text NOT NULL,
	`source` text NOT NULL,
	`language` text NOT NULL,
	`status` text NOT NULL,
	`score` real NOT NULL,
	`margin` real NOT NULL,
	`input_hash` text NOT NULL,
	`detector` text NOT NULL,
	`pipeline_revision` integer NOT NULL,
	PRIMARY KEY(`article_id`, `source`),
	FOREIGN KEY (`article_id`) REFERENCES `articles`(`id`) ON UPDATE no action ON DELETE cascade
);
