ALTER TABLE `config` RENAME COLUMN `default_variant` TO `default_thinking_level`;--> statement-breakpoint
ALTER TABLE `config` RENAME COLUMN `review_variant` TO `review_thinking_level`;--> statement-breakpoint
ALTER TABLE `config` RENAME COLUMN `max_concurrent_opencode_sessions` TO `max_concurrent_agent_turns`;--> statement-breakpoint
ALTER TABLE `repository` RENAME COLUMN `default_variant` TO `default_thinking_level`;--> statement-breakpoint
ALTER TABLE `repository` RENAME COLUMN `review_variant` TO `review_thinking_level`;--> statement-breakpoint
ALTER TABLE `work_item` RENAME COLUMN `variant` TO `thinking_level`;--> statement-breakpoint
ALTER TABLE `work_item` RENAME COLUMN `review_variant` TO `review_thinking_level`;--> statement-breakpoint
ALTER TABLE `work_item` ADD `thinking_level_nullable` text;--> statement-breakpoint
UPDATE `work_item` SET `thinking_level_nullable` = `thinking_level`;--> statement-breakpoint
ALTER TABLE `work_item` DROP COLUMN `thinking_level`;--> statement-breakpoint
ALTER TABLE `work_item` RENAME COLUMN `thinking_level_nullable` TO `thinking_level`;--> statement-breakpoint
ALTER TABLE `work_item` ADD `review_thinking_level_nullable` text;--> statement-breakpoint
UPDATE `work_item` SET `review_thinking_level_nullable` = `review_thinking_level`;--> statement-breakpoint
ALTER TABLE `work_item` DROP COLUMN `review_thinking_level`;--> statement-breakpoint
ALTER TABLE `work_item` RENAME COLUMN `review_thinking_level_nullable` TO `review_thinking_level`;--> statement-breakpoint
UPDATE `step_run` SET `reason_code` = 'waiting_for_agent_turn', `reason_message` = 'Waiting for an Agent Turn slot' WHERE `reason_code` = 'waiting_for_opencode_session';
