-- Durable Autonomous Retry Budget plus a pending-wait flag.
-- The initial Step Run is free; reserved rows count accepted Autonomous
-- Retries whose Step Run was created. pending_autonomous_retry marks a
-- wait that should consume a permit when the Step Run is later created.
ALTER TABLE `work_item` ADD `pending_autonomous_retry` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE TABLE `autonomous_retry` (
	`id` text PRIMARY KEY,
	`work_item_id` text NOT NULL,
	`lifecycle_step` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_autonomous_retry_work_item_id_work_item_id_fk` FOREIGN KEY (`work_item_id`) REFERENCES `work_item`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `autonomous_retry_budget_idx` ON `autonomous_retry` (`work_item_id`,`lifecycle_step`);
