CREATE TRIGGER `work_item_one_unfinished_v3_insert`
BEFORE INSERT ON `work_item`
WHEN NEW.`state` NOT IN ('complete', 'failed', 'abandoned')
  AND EXISTS (
    SELECT 1
    FROM `work_item`
    WHERE `repository_id` = NEW.`repository_id`
      AND `github_issue_number` = NEW.`github_issue_number`
      AND `state` NOT IN ('complete', 'failed', 'abandoned')
  )
BEGIN
  SELECT RAISE(ABORT, 'work_item_one_unfinished_v3_uidx');
END;--> statement-breakpoint
CREATE TRIGGER `work_item_one_unfinished_v3_update`
BEFORE UPDATE OF `repository_id`, `github_issue_number`, `state` ON `work_item`
WHEN NEW.`state` NOT IN ('complete', 'failed', 'abandoned')
  AND EXISTS (
    SELECT 1
    FROM `work_item`
    WHERE `id` <> NEW.`id`
      AND `repository_id` = NEW.`repository_id`
      AND `github_issue_number` = NEW.`github_issue_number`
      AND `state` NOT IN ('complete', 'failed', 'abandoned')
  )
BEGIN
  SELECT RAISE(ABORT, 'work_item_one_unfinished_v3_uidx');
END;
