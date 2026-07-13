DELETE FROM `issue`;--> statement-breakpoint
ALTER TABLE `issue` ADD `body` text NOT NULL;--> statement-breakpoint
ALTER TABLE `issue` ADD `url` text NOT NULL;--> statement-breakpoint
ALTER TABLE `issue` ADD `state` text NOT NULL;--> statement-breakpoint
ALTER TABLE `repository` ADD `issues_reconciled_at` integer;
