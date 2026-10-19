-- Shared Provider Recovery Cooldown. Credentials are never stored.
-- Probe ownership is cleared when the owning Work Item is removed.
CREATE TABLE `provider_recovery_cooldown` (
	`id` text PRIMARY KEY,
	`scope_key` text NOT NULL,
	`scope_kind` text NOT NULL,
	`backend` text NOT NULL,
	`provider_id` text,
	`account_id` text,
	`model` text,
	`next_attempt_at` integer,
	`probe_work_item_id` text,
	`probe_claimed_at` integer,
	`generation` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_provider_recovery_cooldown_probe_work_item_id_work_item_id_fk` FOREIGN KEY (`probe_work_item_id`) REFERENCES `work_item`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `provider_recovery_cooldown_scope_key_uidx` ON `provider_recovery_cooldown` (`scope_key`);
--> statement-breakpoint
ALTER TABLE `provider_recovery_episode` ADD `cooldown_id` text REFERENCES `provider_recovery_cooldown`(`id`) ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX `provider_recovery_episode_cooldown_id_idx` ON `provider_recovery_episode` (`cooldown_id`);
