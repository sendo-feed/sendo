ALTER TABLE `article_translations` ADD `effort` text;--> statement-breakpoint
ALTER TABLE `article_translations` ADD `tier` text;--> statement-breakpoint
ALTER TABLE `article_translations` ADD `prompt_version` integer;--> statement-breakpoint
ALTER TABLE `article_translations` ADD `input_tokens` integer;--> statement-breakpoint
ALTER TABLE `article_translations` ADD `output_tokens` integer;--> statement-breakpoint
ALTER TABLE `article_translations` ADD `call_model` text;--> statement-breakpoint
ALTER TABLE `article_translations` ADD `title_copied_from` text;--> statement-breakpoint
ALTER TABLE `article_translations` ADD `summary_copied_from` text;--> statement-breakpoint
ALTER TABLE `article_translations` ADD `content_copied_from` text;--> statement-breakpoint
ALTER TABLE `article_translations` ADD `batch_tier` text;--> statement-breakpoint
ALTER TABLE `article_translations` ADD `batch_effort` text;--> statement-breakpoint
ALTER TABLE `article_translations` ADD `batch_prompt_version` integer;