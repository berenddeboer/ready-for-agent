-- Shared Commit/PR publication copy (agent-authored title and body).
ALTER TABLE `work_item` ADD `publication_title` text;--> statement-breakpoint
ALTER TABLE `work_item` ADD `publication_body` text;
