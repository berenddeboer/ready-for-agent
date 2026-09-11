ALTER TABLE `step_run` ADD `progress_checkpoint_at` integer;--> statement-breakpoint
ALTER TABLE `step_run` ADD `progress_checkpoint_kind` text;--> statement-breakpoint
ALTER TABLE `step_run` ADD `progress_checkpoint_session_wait_ms` integer;
