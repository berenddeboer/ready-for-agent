-- Durable Provider Recovery Episode and nullable maximum elapsed wait.
-- Null maximum means keep retrying. Waiting owns no Worker Slot.
ALTER TABLE `config` ADD `provider_recovery_max_wait_ms` integer;
--> statement-breakpoint
CREATE TABLE `provider_recovery_episode` (
	`id` text PRIMARY KEY,
	`work_item_id` text NOT NULL,
	`lifecycle_step` text NOT NULL,
	`status` text NOT NULL,
	`provider_id` text,
	`provider_label` text,
	`model` text,
	`provider_code` text,
	`reason_message` text,
	`episode_started_at` integer NOT NULL,
	`attempt_count` integer NOT NULL,
	`next_attempt_at` integer,
	`generation` integer NOT NULL,
	`escalated` integer DEFAULT 0 NOT NULL,
	`exhausted_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_provider_recovery_episode_work_item_id_work_item_id_fk` FOREIGN KEY (`work_item_id`) REFERENCES `work_item`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `provider_recovery_episode_work_item_uidx` ON `provider_recovery_episode` (`work_item_id`);
