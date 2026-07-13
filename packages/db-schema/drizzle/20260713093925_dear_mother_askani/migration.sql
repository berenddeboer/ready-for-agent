CREATE TABLE `config` (
	`id` text PRIMARY KEY DEFAULT 'default',
	`default_model` text DEFAULT 'opencode/deepseek-v4-flash-free' NOT NULL,
	`default_variant` text DEFAULT 'low' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
