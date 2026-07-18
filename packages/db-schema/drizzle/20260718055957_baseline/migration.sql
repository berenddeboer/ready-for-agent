CREATE TABLE IF NOT EXISTS `completed_job` (
	`id` text PRIMARY KEY,
	`queue` text NOT NULL,
	`job_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `config` (
	`id` text PRIMARY KEY DEFAULT 'default',
	`default_model` text,
	`default_variant` text,
	`review_model` text,
	`review_variant` text,
	`max_concurrent_opencode_sessions` integer DEFAULT 2 NOT NULL,
	`max_concurrent_work_items` integer DEFAULT 5 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `issue` (
	`id` text PRIMARY KEY,
	`repository_id` text NOT NULL,
	`github_issue_number` integer NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`url` text NOT NULL,
	`state` text NOT NULL,
	`github_created_at` integer NOT NULL,
	`parent_github_issue_number` integer,
	`parent_github_issue_url` text,
	`parent_position` integer,
	`has_children` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_issue_repository_id_repository_id_fk` FOREIGN KEY (`repository_id`) REFERENCES `repository`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `issue_dependency` (
	`id` text PRIMARY KEY,
	`issue_id` text NOT NULL,
	`blocking_github_issue_number` integer NOT NULL,
	`blocking_github_issue_url` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_issue_dependency_issue_id_issue_id_fk` FOREIGN KEY (`issue_id`) REFERENCES `issue`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `job_queue` (
	`id` text PRIMARY KEY,
	`queue` text NOT NULL,
	`key` text,
	`job_payload` text NOT NULL,
	`job_attempts` integer DEFAULT 0 NOT NULL,
	`job_retry_limit` integer DEFAULT 5 NOT NULL,
	`available_at` integer NOT NULL,
	`locked_until` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `pr_status_check` (
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
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `repository` (
	`id` text PRIMARY KEY,
	`github_owner` text NOT NULL,
	`github_repo` text NOT NULL,
	`local_path` text NOT NULL UNIQUE,
	`is_bare` integer NOT NULL,
	`paused` integer DEFAULT true NOT NULL,
	`default_model` text,
	`default_variant` text,
	`review_model` text,
	`review_variant` text,
	`auto_merge` integer DEFAULT false NOT NULL,
	`issues_reconciled_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `step_run` (
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
CREATE TABLE IF NOT EXISTS `work_item` (
	`id` text PRIMARY KEY,
	`repository_id` text NOT NULL,
	`github_issue_number` integer NOT NULL,
	`github_pull_request_number` integer,
	`model` text NOT NULL,
	`variant` text NOT NULL,
	`review_model` text NOT NULL,
	`review_variant` text NOT NULL,
	`state` text NOT NULL,
	`state_ready_at` integer NOT NULL,
	`paused` integer DEFAULT false NOT NULL,
	`waiting_since` integer,
	`holds_worker_slot` integer DEFAULT false NOT NULL,
	`pause_before_step` text,
	`worktree_path` text,
	`starting_commit_oid` text,
	`session_id` text,
	`failure_code` text,
	`failure_message` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_work_item_repository_id_repository_id_fk` FOREIGN KEY (`repository_id`) REFERENCES `repository`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `completed_job_queue_job_id_uidx` ON `completed_job` (`queue`,`job_id`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `issue_repository_id_github_issue_number_uidx` ON `issue` (`repository_id`,`github_issue_number`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `issue_dependency_issue_id_blocking_url_uidx` ON `issue_dependency` (`issue_id`,`blocking_github_issue_url`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `job_queue_ready_idx` ON `job_queue` (`queue`,`locked_until`,`job_attempts`,`available_at`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `job_queue_queue_key_uidx` ON `job_queue` (`queue`,`key`) WHERE "job_queue"."key" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `pr_status_check_work_item_external_uidx` ON `pr_status_check` (`work_item_id`,`external_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `pr_status_check_work_item_handled_idx` ON `pr_status_check` (`work_item_id`,`handled_at`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `repository_github_owner_repo_lower_uidx` ON `repository` (lower("github_owner"),lower("github_repo"));--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `step_run_one_active_uidx` ON `step_run` (`work_item_id`) WHERE "step_run"."status" IN ('queued', 'running');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `step_run_work_item_id_queued_at_idx` ON `step_run` (`work_item_id`,`queued_at`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `work_item_one_unfinished_v2_uidx` ON `work_item` (`repository_id`,`github_issue_number`) WHERE "work_item"."state" NOT IN ('complete', 'failed', 'abandoned', 'needs_human');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `work_item_repository_issue_created_idx` ON `work_item` (`repository_id`,`github_issue_number`,`created_at`);--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `work_item_one_unfinished_v3_insert`
BEFORE INSERT ON `work_item`
WHEN NEW.`state` NOT IN ('complete', 'failed', 'abandoned')
  AND EXISTS (
    SELECT 1
    FROM `work_item`
    WHERE `repository_id` = NEW.`repository_id`
      AND `github_issue_number` = NEW.`github_issue_number`
      AND `state` NOT IN ('complete', 'failed', 'abandoned')
  )
BEGIN
  SELECT RAISE(ABORT, 'work_item_one_unfinished_v3_uidx');
END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `work_item_one_unfinished_v3_update`
BEFORE UPDATE OF `repository_id`, `github_issue_number`, `state` ON `work_item`
WHEN NEW.`state` NOT IN ('complete', 'failed', 'abandoned')
  AND EXISTS (
    SELECT 1
    FROM `work_item`
    WHERE `id` <> NEW.`id`
      AND `repository_id` = NEW.`repository_id`
      AND `github_issue_number` = NEW.`github_issue_number`
      AND `state` NOT IN ('complete', 'failed', 'abandoned')
  )
BEGIN
  SELECT RAISE(ABORT, 'work_item_one_unfinished_v3_uidx');
END;
