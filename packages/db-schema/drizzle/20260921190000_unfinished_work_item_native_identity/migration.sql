-- Upgrade path: empty native identity placeholders become the issue number.
UPDATE `work_item`
SET `issue_native_id` = CAST(`issue_number` AS TEXT)
WHERE `issue_native_id` IS NULL OR `issue_native_id` = '';--> statement-breakpoint
UPDATE `work_item`
SET `issue_display_id` = CAST(`issue_number` AS TEXT)
WHERE `issue_display_id` IS NULL OR `issue_display_id` = '';--> statement-breakpoint
-- Install the stricter protection first. If unexpected native-id conflicts
-- exist, index creation fails without removing the database's existing
-- unfinished uniqueness.
CREATE UNIQUE INDEX `work_item_one_unfinished_v5_uidx`
  ON `work_item` (`repository_id`, `issue_tracker`, `issue_native_id`)
  WHERE "work_item"."state" NOT IN ('complete', 'failed', 'abandoned');--> statement-breakpoint
DROP INDEX IF EXISTS `work_item_one_unfinished_v4_uidx`;--> statement-breakpoint
CREATE INDEX `work_item_repository_native_id_created_idx`
  ON `work_item` (`repository_id`, `issue_native_id`, `created_at`);
