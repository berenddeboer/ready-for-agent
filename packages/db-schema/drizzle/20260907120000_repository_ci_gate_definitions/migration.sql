-- Repository-owned CI Gate Definition selections. Existing Repositories
-- receive no rows: empty selection disables the Repository CI Gate.
CREATE TABLE `ci_gate_definition` (
	`id` text PRIMARY KEY NOT NULL,
	`repository_id` text NOT NULL,
	`identity` text NOT NULL,
	`display_label` text NOT NULL,
	`kind` text NOT NULL,
	`diagnostic_metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`repository_id`) REFERENCES `repository`(`id`) ON DELETE CASCADE
);--> statement-breakpoint
CREATE UNIQUE INDEX `ci_gate_definition_repository_id_identity_uidx` ON `ci_gate_definition` (`repository_id`,`identity`);--> statement-breakpoint
CREATE INDEX `ci_gate_definition_repository_id_idx` ON `ci_gate_definition` (`repository_id`);
