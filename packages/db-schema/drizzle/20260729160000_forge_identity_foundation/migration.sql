-- Repository identity: existing rows are GitHub repositories on github.com.
DROP INDEX `repository_github_owner_repo_lower_uidx`;--> statement-breakpoint
ALTER TABLE `repository` RENAME COLUMN `github_owner` TO `project_path`;--> statement-breakpoint
UPDATE `repository`
SET `project_path` = `project_path` || '/' || `github_repo`;--> statement-breakpoint
ALTER TABLE `repository` DROP COLUMN `github_repo`;--> statement-breakpoint
ALTER TABLE `repository` ADD `forge` text DEFAULT 'github' NOT NULL;--> statement-breakpoint
ALTER TABLE `repository` ADD `forge_host` text DEFAULT 'github.com' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `repository_forge_host_project_path_lower_uidx`
ON `repository` (`forge`, `forge_host`, lower(`project_path`));--> statement-breakpoint

-- Forge-neutral issue and pull request number columns.
DROP INDEX `issue_repository_id_github_issue_number_uidx`;--> statement-breakpoint
ALTER TABLE `issue` RENAME COLUMN `github_issue_number` TO `issue_number`;--> statement-breakpoint
ALTER TABLE `issue` RENAME COLUMN `parent_github_issue_number` TO `parent_issue_number`;--> statement-breakpoint
ALTER TABLE `issue` RENAME COLUMN `parent_github_issue_url` TO `parent_issue_url`;--> statement-breakpoint
CREATE UNIQUE INDEX `issue_repository_id_issue_number_uidx`
ON `issue` (`repository_id`, `issue_number`);--> statement-breakpoint

ALTER TABLE `issue_dependency`
RENAME COLUMN `blocking_github_issue_number` TO `blocking_issue_number`;--> statement-breakpoint
ALTER TABLE `issue_dependency`
RENAME COLUMN `blocking_github_issue_url` TO `blocking_issue_url`;--> statement-breakpoint

ALTER TABLE `work_item`
RENAME COLUMN `github_issue_number` TO `issue_number`;--> statement-breakpoint
ALTER TABLE `work_item`
RENAME COLUMN `github_pull_request_number` TO `pull_request_number`;
