-- Manual repository CI repair invocation. Not a Work Item. At most one
-- queued or running repair per repository. Restart reconciles other epochs.
CREATE TABLE `ci_repair_invocation` (
	`id` text PRIMARY KEY NOT NULL,
	`repository_id` text NOT NULL,
	`incident_id` text NOT NULL,
	`status` text NOT NULL,
	`outcome` text,
	`supervisor_epoch` text NOT NULL,
	`admitted_at` integer NOT NULL,
	`launched_at` integer,
	`deadline_at` integer,
	`session_id` text,
	`process_ref` text,
	`report` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`repository_id`) REFERENCES `repository`(`id`) ON DELETE CASCADE,
	FOREIGN KEY (`incident_id`) REFERENCES `ci_failure_incident`(`id`) ON DELETE CASCADE
);--> statement-breakpoint
CREATE UNIQUE INDEX `ci_repair_invocation_one_active_uidx` ON `ci_repair_invocation` (`repository_id`) WHERE `status` IN ('queued', 'running');--> statement-breakpoint
CREATE INDEX `ci_repair_invocation_repository_id_admitted_at_idx` ON `ci_repair_invocation` (`repository_id`,`admitted_at`);--> statement-breakpoint
CREATE INDEX `ci_repair_invocation_incident_id_idx` ON `ci_repair_invocation` (`incident_id`);--> statement-breakpoint
CREATE TABLE `ci_repair_invocation_link` (
	`id` text PRIMARY KEY NOT NULL,
	`invocation_id` text NOT NULL,
	`url` text NOT NULL,
	`kind` text NOT NULL,
	`disposition` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`invocation_id`) REFERENCES `ci_repair_invocation`(`id`) ON DELETE CASCADE
);--> statement-breakpoint
CREATE UNIQUE INDEX `ci_repair_invocation_link_invocation_id_url_uidx` ON `ci_repair_invocation_link` (`invocation_id`,`url`);--> statement-breakpoint
CREATE INDEX `ci_repair_invocation_link_invocation_id_idx` ON `ci_repair_invocation_link` (`invocation_id`);
