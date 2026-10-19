-- CI Repair Baseline and the GitHub early-job-failure signal.
-- Existing observations have no order key until the next poll.
ALTER TABLE `ci_gate_definition_observation` ADD `last_run_order_key` text;--> statement-breakpoint
ALTER TABLE `ci_gate_definition_observation` ADD `latched_run_order_key` text;--> statement-breakpoint
ALTER TABLE `ci_gate_definition_observation` ADD `last_early_job_failure` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE TABLE `ci_repair_baseline` (
	`repository_id` text NOT NULL,
	`definition_identity` text NOT NULL,
	`run_identity` text,
	`order_key` text,
	`head_sha` text,
	`inclusive` integer DEFAULT false NOT NULL,
	`floor_order_key` text,
	`suppress_through_run_identity` text,
	`suppress_through_order_key` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`repository_id`) REFERENCES `repository`(`id`) ON DELETE CASCADE
);--> statement-breakpoint
CREATE UNIQUE INDEX `ci_repair_baseline_repository_id_identity_uidx` ON `ci_repair_baseline` (`repository_id`, `definition_identity`);
