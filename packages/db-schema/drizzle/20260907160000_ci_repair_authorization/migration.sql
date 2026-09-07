-- Append-only CI Repair authorization provenance. Existing Work Items migrate
-- with no authorizations. Effectiveness is derived from the currently open
-- CI Failure Incident; resolved rows remain historical.
CREATE TABLE `ci_repair_authorization` (
	`id` text PRIMARY KEY NOT NULL,
	`repository_id` text NOT NULL,
	`work_item_id` text NOT NULL,
	`incident_id` text NOT NULL,
	`source_action` text NOT NULL,
	`authorized_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`repository_id`) REFERENCES `repository`(`id`) ON DELETE CASCADE,
	FOREIGN KEY (`work_item_id`) REFERENCES `work_item`(`id`) ON DELETE CASCADE,
	FOREIGN KEY (`incident_id`) REFERENCES `ci_failure_incident`(`id`) ON DELETE CASCADE
);--> statement-breakpoint
CREATE UNIQUE INDEX `ci_repair_authorization_work_item_id_incident_id_uidx` ON `ci_repair_authorization` (`work_item_id`,`incident_id`);--> statement-breakpoint
CREATE INDEX `ci_repair_authorization_repository_id_idx` ON `ci_repair_authorization` (`repository_id`);--> statement-breakpoint
CREATE INDEX `ci_repair_authorization_incident_id_idx` ON `ci_repair_authorization` (`incident_id`);--> statement-breakpoint
CREATE INDEX `ci_repair_authorization_work_item_id_idx` ON `ci_repair_authorization` (`work_item_id`);
