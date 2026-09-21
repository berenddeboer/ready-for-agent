-- SQLite requires a constant default when adding NOT NULL columns.
ALTER TABLE `repository` ADD `issue_tracker` text DEFAULT 'github' NOT NULL;--> statement-breakpoint
UPDATE `repository` SET `issue_tracker` = `forge`;--> statement-breakpoint

ALTER TABLE `work_item` ADD `issue_tracker` text DEFAULT 'github' NOT NULL;--> statement-breakpoint
ALTER TABLE `work_item` ADD `issue_native_id` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `work_item` ADD `issue_display_id` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `work_item` ADD `issue_url` text DEFAULT '' NOT NULL;--> statement-breakpoint
UPDATE `work_item`
SET
  `issue_tracker` = (
    SELECT `forge` FROM `repository` WHERE `repository`.`id` = `work_item`.`repository_id`
  ),
  `issue_native_id` = CAST(`issue_number` AS TEXT),
  `issue_display_id` = CAST(`issue_number` AS TEXT),
  `issue_url` = COALESCE(
    (
      SELECT `url` FROM `issue`
      WHERE `issue`.`repository_id` = `work_item`.`repository_id`
        AND `issue`.`issue_number` = `work_item`.`issue_number`
    ),
    CASE (
      SELECT `forge` FROM `repository` WHERE `repository`.`id` = `work_item`.`repository_id`
    )
      WHEN 'gitlab' THEN
        'https://' || (SELECT `forge_host` FROM `repository` WHERE `repository`.`id` = `work_item`.`repository_id`)
        || '/' || (SELECT `project_path` FROM `repository` WHERE `repository`.`id` = `work_item`.`repository_id`)
        || '/-/issues/' || `issue_number`
      WHEN 'azure-devops' THEN
        'https://' || (SELECT `forge_host` FROM `repository` WHERE `repository`.`id` = `work_item`.`repository_id`)
        || '/' || (
          SELECT
            CASE
              WHEN instr(substr(`project_path`, instr(`project_path`, '/') + 1), '/') > 0
              THEN substr(
                `project_path`,
                1,
                instr(`project_path`, '/')
                  + instr(substr(`project_path`, instr(`project_path`, '/') + 1), '/')
                  - 1
              )
              ELSE `project_path`
            END
          FROM `repository`
          WHERE `repository`.`id` = `work_item`.`repository_id`
        )
        || '/_workitems/edit/' || `issue_number`
      ELSE
        'https://' || (SELECT `forge_host` FROM `repository` WHERE `repository`.`id` = `work_item`.`repository_id`)
        || '/' || (SELECT `project_path` FROM `repository` WHERE `repository`.`id` = `work_item`.`repository_id`)
        || '/issues/' || `issue_number`
    END
  );
