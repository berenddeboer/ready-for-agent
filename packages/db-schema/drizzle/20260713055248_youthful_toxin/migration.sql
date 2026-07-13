CREATE TABLE `issue` (
	`id` text PRIMARY KEY,
	`repository_id` text NOT NULL,
	`github_issue_number` integer NOT NULL,
	`title` text NOT NULL,
	`github_created_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_issue_repository_id_repository_id_fk` FOREIGN KEY (`repository_id`) REFERENCES `repository`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `issue_repository_id_github_issue_number_uidx` ON `issue` (`repository_id`,`github_issue_number`);