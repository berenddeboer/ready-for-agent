ALTER TABLE `step_run` ADD `session_wait_ms` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `step_run` ADD `session_wait_started_at` integer;