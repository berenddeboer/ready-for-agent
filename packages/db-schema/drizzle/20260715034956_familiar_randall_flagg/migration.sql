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
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pr_status_check_work_item_external_uidx` ON `pr_status_check` (`work_item_id`,`external_id`);--> statement-breakpoint
CREATE INDEX `pr_status_check_work_item_handled_idx` ON `pr_status_check` (`work_item_id`,`handled_at`);