-- Observed Repository CI Gate state, per-definition latches, and CI Failure
-- Incidents. Existing Repositories receive no rows.
CREATE TABLE `ci_gate_state` (
	`repository_id` text PRIMARY KEY NOT NULL,
	`default_branch` text,
	`last_observed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`repository_id`) REFERENCES `repository`(`id`) ON DELETE CASCADE
);--> statement-breakpoint
CREATE TABLE `ci_gate_definition_observation` (
	`id` text PRIMARY KEY NOT NULL,
	`repository_id` text NOT NULL,
	`definition_identity` text NOT NULL,
	`last_observed_at` integer,
	`last_run_identity` text,
	`last_run_html_url` text,
	`last_head_sha` text,
	`last_head_ref` text,
	`last_event` text,
	`last_raw_status` text,
	`last_raw_conclusion` text,
	`last_run_created_at` integer,
	`last_run_updated_at` integer,
	`failure_latched` integer DEFAULT false NOT NULL,
	`latched_run_identity` text,
	`latched_run_html_url` text,
	`observation_error` text,
	`observation_error_kind` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`repository_id`) REFERENCES `repository`(`id`) ON DELETE CASCADE
);--> statement-breakpoint
CREATE UNIQUE INDEX `ci_gate_definition_observation_repository_id_identity_uidx` ON `ci_gate_definition_observation` (`repository_id`,`definition_identity`);--> statement-breakpoint
CREATE INDEX `ci_gate_definition_observation_repository_id_idx` ON `ci_gate_definition_observation` (`repository_id`);--> statement-breakpoint
CREATE TABLE `ci_failure_incident` (
	`id` text PRIMARY KEY NOT NULL,
	`repository_id` text NOT NULL,
	`status` text NOT NULL,
	`opened_at` integer NOT NULL,
	`resolved_at` integer,
	`recovery_reason` text,
	`summary` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`repository_id`) REFERENCES `repository`(`id`) ON DELETE CASCADE
);--> statement-breakpoint
CREATE INDEX `ci_failure_incident_repository_id_status_idx` ON `ci_failure_incident` (`repository_id`,`status`);--> statement-breakpoint
CREATE INDEX `ci_failure_incident_repository_id_opened_at_idx` ON `ci_failure_incident` (`repository_id`,`opened_at`);--> statement-breakpoint
CREATE TABLE `ci_failure_incident_definition` (
	`incident_id` text NOT NULL,
	`definition_identity` text NOT NULL,
	`display_label` text NOT NULL,
	`first_failed_run_identity` text,
	`first_failed_run_html_url` text,
	`joined_at` integer NOT NULL,
	FOREIGN KEY (`incident_id`) REFERENCES `ci_failure_incident`(`id`) ON DELETE CASCADE
);--> statement-breakpoint
CREATE UNIQUE INDEX `ci_failure_incident_definition_incident_id_identity_uidx` ON `ci_failure_incident_definition` (`incident_id`,`definition_identity`);--> statement-breakpoint
CREATE INDEX `ci_failure_incident_definition_incident_id_idx` ON `ci_failure_incident_definition` (`incident_id`);
