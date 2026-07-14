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
);
--> statement-breakpoint
CREATE TABLE `work_item` (
	`id` text PRIMARY KEY,
	`repository_id` text NOT NULL,
	`github_issue_number` integer NOT NULL,
	`model` text NOT NULL,
	`variant` text NOT NULL,
	`state` text NOT NULL,
	`state_ready_at` integer NOT NULL,
	`worktree_path` text,
	`session_id` text,
	`failure_code` text,
	`failure_message` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_work_item_repository_id_repository_id_fk` FOREIGN KEY (`repository_id`) REFERENCES `repository`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `step_run_one_active_uidx` ON `step_run` (`work_item_id`) WHERE "step_run"."status" IN ('queued', 'running');--> statement-breakpoint
CREATE INDEX `step_run_work_item_id_queued_at_idx` ON `step_run` (`work_item_id`,`queued_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `work_item_one_unfinished_uidx` ON `work_item` (`repository_id`,`github_issue_number`) WHERE "work_item"."state" NOT IN ('complete', 'failed', 'abandoned');--> statement-breakpoint
CREATE INDEX `work_item_repository_issue_created_idx` ON `work_item` (`repository_id`,`github_issue_number`,`created_at`);