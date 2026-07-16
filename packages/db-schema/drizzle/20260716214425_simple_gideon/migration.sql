ALTER TABLE `job_queue` ADD `key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `job_queue_queue_key_uidx` ON `job_queue` (`queue`,`key`) WHERE "job_queue"."key" IS NOT NULL;