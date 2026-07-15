ALTER TABLE `repository` ADD `default_model` text;--> statement-breakpoint
ALTER TABLE `repository` ADD `default_variant` text;--> statement-breakpoint
ALTER TABLE `repository` ADD `auto_merge` integer DEFAULT false NOT NULL;