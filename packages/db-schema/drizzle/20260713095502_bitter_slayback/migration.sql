CREATE TABLE `issue_dependency` (
	`id` text PRIMARY KEY,
	`issue_id` text NOT NULL,
	`blocking_github_issue_number` integer NOT NULL,
	`blocking_github_issue_url` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_issue_dependency_issue_id_issue_id_fk` FOREIGN KEY (`issue_id`) REFERENCES `issue`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `issue_dependency_issue_id_blocking_url_uidx` ON `issue_dependency` (`issue_id`,`blocking_github_issue_url`);