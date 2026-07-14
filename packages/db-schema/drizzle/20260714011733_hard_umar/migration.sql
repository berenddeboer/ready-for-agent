ALTER TABLE `issue` ADD `has_children` integer DEFAULT false NOT NULL;--> statement-breakpoint
DELETE FROM `issue_dependency`;--> statement-breakpoint
DELETE FROM `issue`;--> statement-breakpoint
UPDATE `repository` SET `issues_reconciled_at` = NULL;
