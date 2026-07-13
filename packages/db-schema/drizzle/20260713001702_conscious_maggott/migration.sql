CREATE TABLE `completed_job` (
	`id` text PRIMARY KEY,
	`queue` text NOT NULL,
	`job_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `job_queue` (
	`id` text PRIMARY KEY,
	`queue` text NOT NULL,
	`job_payload` text NOT NULL,
	`job_attempts` integer DEFAULT 0 NOT NULL,
	`job_retry_limit` integer DEFAULT 5 NOT NULL,
	`available_at` integer NOT NULL,
	`locked_until` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `completed_job_queue_job_id_uidx` ON `completed_job` (`queue`,`job_id`);--> statement-breakpoint
CREATE INDEX `job_queue_ready_idx` ON `job_queue` (`queue`,`locked_until`,`job_attempts`,`available_at`);