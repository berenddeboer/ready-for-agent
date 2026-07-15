ALTER TABLE `config` ADD `review_model` text;--> statement-breakpoint
ALTER TABLE `config` ADD `review_variant` text;--> statement-breakpoint
ALTER TABLE `repository` ADD `review_model` text;--> statement-breakpoint
ALTER TABLE `repository` ADD `review_variant` text;--> statement-breakpoint
ALTER TABLE `work_item` ADD `review_model` text;--> statement-breakpoint
ALTER TABLE `work_item` ADD `review_variant` text;--> statement-breakpoint
UPDATE `work_item` SET `review_model` = `model`, `review_variant` = `variant`;--> statement-breakpoint
CREATE TEMP TABLE `__step_run_backup` AS SELECT * FROM `step_run`;--> statement-breakpoint
CREATE TEMP TABLE `__pr_status_check_backup` AS SELECT * FROM `pr_status_check`;--> statement-breakpoint
DROP TABLE `step_run`;--> statement-breakpoint
DROP TABLE `pr_status_check`;--> statement-breakpoint
CREATE TABLE `__new_work_item` (
	`id` text PRIMARY KEY,
	`repository_id` text NOT NULL,
	`github_issue_number` integer NOT NULL,
	`model` text NOT NULL,
	`variant` text NOT NULL,
	`review_model` text NOT NULL,
	`review_variant` text NOT NULL,
	`state` text NOT NULL,
	`state_ready_at` integer NOT NULL,
	`worktree_path` text,
	`session_id` text,
	`failure_code` text,
	`failure_message` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_work_item_repository_id_repository_id_fk` FOREIGN KEY (`repository_id`) REFERENCES `repository`(`id`) ON DELETE CASCADE
);--> statement-breakpoint
INSERT INTO `__new_work_item` (
	`id`, `repository_id`, `github_issue_number`, `model`, `variant`,
	`review_model`, `review_variant`, `state`, `state_ready_at`, `worktree_path`,
	`session_id`, `failure_code`, `failure_message`, `created_at`, `updated_at`
) SELECT
	`id`, `repository_id`, `github_issue_number`, `model`, `variant`,
	`review_model`, `review_variant`, `state`, `state_ready_at`, `worktree_path`,
	`session_id`, `failure_code`, `failure_message`, `created_at`, `updated_at`
FROM `work_item`;--> statement-breakpoint
DROP TABLE `work_item`;--> statement-breakpoint
ALTER TABLE `__new_work_item` RENAME TO `work_item`;--> statement-breakpoint
CREATE UNIQUE INDEX `work_item_one_unfinished_v2_uidx` ON `work_item` (`repository_id`,`github_issue_number`) WHERE "work_item"."state" NOT IN ('complete', 'failed', 'abandoned', 'needs_human');--> statement-breakpoint
CREATE INDEX `work_item_repository_issue_created_idx` ON `work_item` (`repository_id`,`github_issue_number`,`created_at`);--> statement-breakpoint
CREATE TABLE `step_run` (
	`id` text PRIMARY KEY,
	`work_item_id` text NOT NULL,
	`step` text NOT NULL,
	`status` text NOT NULL,
	`queue_job_id` text,
	`queued_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	`reason_code` text,
	`reason_message` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_step_run_work_item_id_work_item_id_fk` FOREIGN KEY (`work_item_id`) REFERENCES `work_item`(`id`) ON DELETE CASCADE
);--> statement-breakpoint
INSERT INTO `step_run` SELECT * FROM `__step_run_backup`;--> statement-breakpoint
CREATE UNIQUE INDEX `step_run_one_active_uidx` ON `step_run` (`work_item_id`) WHERE "step_run"."status" IN ('queued', 'running');--> statement-breakpoint
CREATE INDEX `step_run_work_item_id_queued_at_idx` ON `step_run` (`work_item_id`,`queued_at`);--> statement-breakpoint
CREATE TABLE `pr_status_check` (
	`id` text PRIMARY KEY,
	`work_item_id` text NOT NULL,
	`external_id` text NOT NULL,
	`name` text NOT NULL,
	`outcome` text NOT NULL,
	`handled_at` integer,
	`observed_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_pr_status_check_work_item_id_work_item_id_fk` FOREIGN KEY (`work_item_id`) REFERENCES `work_item`(`id`) ON DELETE CASCADE
);--> statement-breakpoint
INSERT INTO `pr_status_check` SELECT * FROM `__pr_status_check_backup`;--> statement-breakpoint
CREATE UNIQUE INDEX `pr_status_check_work_item_external_uidx` ON `pr_status_check` (`work_item_id`,`external_id`);--> statement-breakpoint
CREATE INDEX `pr_status_check_work_item_handled_idx` ON `pr_status_check` (`work_item_id`,`handled_at`);--> statement-breakpoint
DROP TABLE `__step_run_backup`;--> statement-breakpoint
DROP TABLE `__pr_status_check_backup`;
