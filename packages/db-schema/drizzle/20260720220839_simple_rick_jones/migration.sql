ALTER TABLE `pr_status_check` ADD `handled_by_step_run_id` text REFERENCES step_run(id) ON DELETE SET NULL;--> statement-breakpoint
UPDATE `pr_status_check`
SET `handled_by_step_run_id` = (
  SELECT `step_run`.`id`
  FROM `step_run`
  INNER JOIN `work_item` ON `work_item`.`id` = `step_run`.`work_item_id`
  WHERE `step_run`.`work_item_id` = `pr_status_check`.`work_item_id`
    AND `work_item`.`state` = 'needs_human'
    AND `step_run`.`step` = 'investigate_pr_status_checks'
    AND `step_run`.`status` = 'succeeded'
    AND `step_run`.`finished_at` = `pr_status_check`.`handled_at`
  ORDER BY `step_run`.`queued_at` DESC, `step_run`.rowid DESC
  LIMIT 1
)
WHERE `handled_at` IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM `step_run`
    INNER JOIN `work_item` ON `work_item`.`id` = `step_run`.`work_item_id`
    WHERE `step_run`.`work_item_id` = `pr_status_check`.`work_item_id`
      AND `work_item`.`state` = 'needs_human'
      AND `step_run`.`step` = 'investigate_pr_status_checks'
      AND `step_run`.`status` = 'succeeded'
      AND `step_run`.`finished_at` = `pr_status_check`.`handled_at`
  );--> statement-breakpoint
CREATE INDEX `pr_status_check_handled_by_step_run_idx` ON `pr_status_check` (`handled_by_step_run_id`);
