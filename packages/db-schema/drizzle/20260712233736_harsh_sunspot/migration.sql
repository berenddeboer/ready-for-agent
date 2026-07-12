CREATE TABLE `repository` (
	`id` text PRIMARY KEY,
	`github_owner` text NOT NULL,
	`github_repo` text NOT NULL,
	`local_path` text NOT NULL UNIQUE,
	`is_bare` integer NOT NULL,
	`paused` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `repository_github_owner_repo_lower_uidx` ON `repository` (lower("github_owner"),lower("github_repo"));