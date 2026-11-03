-- Separate Historical Coverage from the latest run. Existing observations
-- become checkpoints so live observation can resume without fetching history.
ALTER TABLE `ci_gate_definition_observation` ADD `coverage_state` text DEFAULT 'complete' NOT NULL;--> statement-breakpoint
ALTER TABLE `ci_gate_definition_observation` ADD `coverage_branch` text;--> statement-breakpoint
ALTER TABLE `ci_gate_definition_observation` ADD `coverage_checkpoint_run_identity` text;--> statement-breakpoint
ALTER TABLE `ci_gate_definition_observation` ADD `coverage_checkpoint_order_key` text;--> statement-breakpoint
ALTER TABLE `ci_gate_definition_observation` ADD `coverage_checkpoint_created_at` integer;--> statement-breakpoint
ALTER TABLE `ci_gate_definition_observation` ADD `coverage_gap_upper_run_identity` text;--> statement-breakpoint
ALTER TABLE `ci_gate_definition_observation` ADD `coverage_gap_upper_order_key` text;--> statement-breakpoint
ALTER TABLE `ci_gate_definition_observation` ADD `coverage_gap_upper_created_at` integer;--> statement-breakpoint
ALTER TABLE `ci_gate_definition_observation` ADD `coverage_progress_run_identity` text;--> statement-breakpoint
ALTER TABLE `ci_gate_definition_observation` ADD `coverage_progress_order_key` text;--> statement-breakpoint
ALTER TABLE `ci_gate_definition_observation` ADD `coverage_progress_created_at` integer;--> statement-breakpoint
ALTER TABLE `ci_gate_definition_observation` ADD `coverage_stop_run_identity` text;--> statement-breakpoint
ALTER TABLE `ci_gate_definition_observation` ADD `coverage_stop_order_key` text;--> statement-breakpoint
ALTER TABLE `ci_gate_definition_observation` ADD `coverage_stop_created_at` integer;--> statement-breakpoint
ALTER TABLE `ci_gate_definition_observation` ADD `coverage_head_floor_run_identity` text;--> statement-breakpoint
ALTER TABLE `ci_gate_definition_observation` ADD `coverage_head_floor_order_key` text;--> statement-breakpoint
ALTER TABLE `ci_gate_definition_observation` ADD `coverage_head_floor_created_at` integer;--> statement-breakpoint
ALTER TABLE `ci_gate_definition_observation` ADD `coverage_pages_processed` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `ci_gate_definition_observation` ADD `coverage_diagnostic` text;--> statement-breakpoint
ALTER TABLE `ci_gate_definition_observation` ADD `coverage_pending_runs` text;--> statement-breakpoint
UPDATE `ci_gate_definition_observation`
SET `coverage_state` = 'complete',
    `coverage_checkpoint_run_identity` = `last_run_identity`,
    `coverage_checkpoint_order_key` = `last_run_order_key`,
    `coverage_checkpoint_created_at` = `last_run_created_at`,
    `coverage_progress_run_identity` = `last_run_identity`,
    `coverage_progress_order_key` = `last_run_order_key`,
    `coverage_progress_created_at` = `last_run_created_at`,
    `coverage_head_floor_run_identity` = `last_run_identity`,
    `coverage_head_floor_order_key` = `last_run_order_key`,
    `coverage_head_floor_created_at` = `last_run_created_at`,
    `coverage_pages_processed` = 0
WHERE `last_run_identity` IS NOT NULL;
