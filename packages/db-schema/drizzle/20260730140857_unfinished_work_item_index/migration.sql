-- Install the stricter protection first. If unexpected legacy conflicts exist,
-- index creation fails without removing the database's existing protection.
CREATE UNIQUE INDEX `work_item_one_unfinished_v4_uidx` ON `work_item` (`repository_id`,`issue_number`) WHERE "work_item"."state" NOT IN ('complete', 'failed', 'abandoned');--> statement-breakpoint
DROP INDEX IF EXISTS `work_item_one_unfinished_v2_uidx`;--> statement-breakpoint
DROP INDEX IF EXISTS `work_item_one_unfinished_uidx`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `work_item_one_unfinished_v3_insert`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `work_item_one_unfinished_v3_update`;
