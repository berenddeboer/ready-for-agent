-- SQLite requires a constant default when adding NOT NULL columns.
ALTER TABLE `issue` ADD `issue_tracker` text DEFAULT 'github' NOT NULL;--> statement-breakpoint
ALTER TABLE `issue` ADD `issue_native_id` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `issue` ADD `issue_display_id` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `issue` ADD `parent_native_id` text;--> statement-breakpoint
ALTER TABLE `issue` ADD `parent_display_id` text;--> statement-breakpoint
ALTER TABLE `issue_dependency` ADD `blocking_native_id` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `issue_dependency` ADD `blocking_display_id` text DEFAULT '' NOT NULL;--> statement-breakpoint

UPDATE `issue`
SET
  `issue_tracker` = (
    SELECT `issue_tracker` FROM `repository`
    WHERE `repository`.`id` = `issue`.`repository_id`
  ),
  `issue_native_id` = CAST(`issue_number` AS TEXT),
  `issue_display_id` = CAST(`issue_number` AS TEXT),
  `parent_native_id` = CASE
    WHEN `parent_issue_number` IS NULL THEN NULL
    ELSE CAST(`parent_issue_number` AS TEXT)
  END,
  `parent_display_id` = CASE
    WHEN `parent_issue_number` IS NULL THEN NULL
    ELSE CAST(`parent_issue_number` AS TEXT)
  END;--> statement-breakpoint

UPDATE `issue_dependency`
SET
  `blocking_native_id` = CAST(`blocking_issue_number` AS TEXT),
  `blocking_display_id` = CAST(`blocking_issue_number` AS TEXT);--> statement-breakpoint

CREATE UNIQUE INDEX `issue_repository_id_tracker_native_id_uidx`
  ON `issue` (`repository_id`, `issue_tracker`, `issue_native_id`);
