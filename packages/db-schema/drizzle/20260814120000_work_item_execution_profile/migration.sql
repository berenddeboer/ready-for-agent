-- Explicit Work Item Execution Profile. Existing rows have no profile
-- (settings-resolved model behavior is unchanged).
ALTER TABLE `work_item` ADD `execution_profile_present` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `work_item` ADD `execution_profile_build_model` text;--> statement-breakpoint
ALTER TABLE `work_item` ADD `execution_profile_build_thinking_level` text;--> statement-breakpoint
ALTER TABLE `work_item` ADD `execution_profile_review_same_as_build` integer;--> statement-breakpoint
ALTER TABLE `work_item` ADD `execution_profile_review_model` text;--> statement-breakpoint
ALTER TABLE `work_item` ADD `execution_profile_review_thinking_level` text;
