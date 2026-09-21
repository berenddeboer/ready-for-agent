ALTER TABLE `repository` ADD `linear_project_id` text;--> statement-breakpoint
ALTER TABLE `repository` ADD `linear_project_name` text;--> statement-breakpoint
ALTER TABLE `repository` ADD `linear_workflow_statuses` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `repository_linear_project_id_uidx`
  ON `repository` (`linear_project_id`)
  WHERE `linear_project_id` IS NOT NULL AND `linear_project_id` != '';--> statement-breakpoint
DROP INDEX IF EXISTS `issue_repository_id_issue_number_uidx`;--> statement-breakpoint
CREATE INDEX `issue_repository_id_issue_number_idx`
  ON `issue` (`repository_id`, `issue_number`);
