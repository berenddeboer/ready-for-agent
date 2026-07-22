ALTER TABLE `issue` ADD `issue_author` text;--> statement-breakpoint
ALTER TABLE `repository` ADD `include_all_issue_authors` integer DEFAULT false NOT NULL;