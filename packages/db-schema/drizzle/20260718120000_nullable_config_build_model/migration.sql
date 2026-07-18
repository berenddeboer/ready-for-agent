CREATE TABLE `__new_config` (
	`id` text PRIMARY KEY DEFAULT 'default',
	`default_model` text,
	`default_variant` text,
	`review_model` text,
	`review_variant` text,
	`max_concurrent_opencode_sessions` integer DEFAULT 2 NOT NULL,
	`max_concurrent_work_items` integer DEFAULT 5 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);--> statement-breakpoint
INSERT INTO `__new_config` (
	`id`, `default_model`, `default_variant`, `review_model`, `review_variant`,
	`max_concurrent_opencode_sessions`, `max_concurrent_work_items`,
	`created_at`, `updated_at`
) SELECT
	`id`, `default_model`, `default_variant`, `review_model`, `review_variant`,
	`max_concurrent_opencode_sessions`, `max_concurrent_work_items`,
	`created_at`, `updated_at`
FROM `config`;--> statement-breakpoint
DROP TABLE `config`;--> statement-breakpoint
ALTER TABLE `__new_config` RENAME TO `config`;
