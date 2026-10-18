-- Opt-in automatic CI repair. Off for existing and new Repositories.
-- One automatic attempt per CI Failure Incident. Any admitted repair,
-- manual or automatic, consumes that eligibility.
ALTER TABLE `repository` ADD `automatic_ci_repair` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `ci_failure_incident` ADD `automatic_repair_eligible` integer DEFAULT true NOT NULL;--> statement-breakpoint
UPDATE `ci_failure_incident`
SET `automatic_repair_eligible` = 0
WHERE `id` IN (SELECT `incident_id` FROM `ci_repair_invocation`);--> statement-breakpoint
ALTER TABLE `ci_repair_invocation` ADD `request_source` text DEFAULT 'manual' NOT NULL;
