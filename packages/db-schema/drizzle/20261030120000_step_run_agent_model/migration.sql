-- Durable model selected for an agent execution. Legacy Step Runs have no rows.
-- Review may record both roles; other agent steps record build only.
CREATE TABLE `step_run_agent_model` (
	`id` text PRIMARY KEY NOT NULL,
	`step_run_id` text NOT NULL,
	`role` text NOT NULL,
	`model` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_step_run_agent_model_step_run_id_step_run_id_fk` FOREIGN KEY (`step_run_id`) REFERENCES `step_run`(`id`) ON DELETE CASCADE,
	CONSTRAINT `step_run_agent_model_role_check` CHECK (`role` IN ('build', 'review'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `step_run_agent_model_run_role_uidx` ON `step_run_agent_model` (`step_run_id`, `role`);
--> statement-breakpoint
CREATE INDEX `step_run_agent_model_model_idx` ON `step_run_agent_model` (`model`);
