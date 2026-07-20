ALTER TABLE `work_item` ADD `issue_title` text;
UPDATE `work_item`
SET `issue_title` = (
  SELECT `issue`.`title`
  FROM `issue`
  WHERE `issue`.`repository_id` = `work_item`.`repository_id`
    AND `issue`.`github_issue_number` = `work_item`.`github_issue_number`
);
