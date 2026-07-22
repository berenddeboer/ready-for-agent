CREATE TABLE `automated_review_rerun` (
	`id` text PRIMARY KEY,
	`work_item_id` text NOT NULL,
	`head_sha` text NOT NULL,
	`workflow_run_id` text NOT NULL,
	`workflow_name` text,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_automated_review_rerun_work_item_id_work_item_id_fk` FOREIGN KEY (`work_item_id`) REFERENCES `work_item`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `automated_review_rerun_budget_idx` ON `automated_review_rerun` (`work_item_id`,`head_sha`,`workflow_run_id`);