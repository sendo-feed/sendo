ALTER TABLE `article_translations` ADD `url_key` text;--> statement-breakpoint
ALTER TABLE `article_translations` ADD `body_hash` text;--> statement-breakpoint
ALTER TABLE `article_translations` ADD `batch_copies` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `article_translations_url_key_idx` ON `article_translations` (`url_key`,`status`) WHERE url_key is not null;