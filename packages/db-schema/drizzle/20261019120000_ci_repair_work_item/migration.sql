-- CI Repair Work Item replaces the agent-owned CI repair invocation.
-- Existing rows are Issue-origin Work Items. Invocation history is dropped.
ALTER TABLE `work_item` ADD `origin` text DEFAULT 'issue' NOT NULL;--> statement-breakpoint
ALTER TABLE `work_item` ADD `ci_repair_default_branch` text;--> statement-breakpoint
ALTER TABLE `work_item` ADD `ci_repair_head_sha` text;--> statement-breakpoint
ALTER TABLE `work_item` ADD `ci_repair_failing_runs` text;--> statement-breakpoint
CREATE UNIQUE INDEX `work_item_one_unfinished_ci_repair_uidx` ON `work_item` (`repository_id`) WHERE `origin` = 'ci_repair' AND `state` NOT IN ('complete', 'failed', 'abandoned');--> statement-breakpoint
DROP TABLE `ci_repair_invocation_link`;--> statement-breakpoint
DROP TABLE `ci_repair_invocation`;--> statement-breakpoint
ALTER TABLE `ci_failure_incident` DROP COLUMN `automatic_repair_eligible`;
