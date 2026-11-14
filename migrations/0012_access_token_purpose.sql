ALTER TABLE `access_tokens` ADD `purpose` text DEFAULT 'reader' NOT NULL;--> statement-breakpoint
ALTER TABLE `access_tokens` ADD `scopes` text DEFAULT '' NOT NULL;