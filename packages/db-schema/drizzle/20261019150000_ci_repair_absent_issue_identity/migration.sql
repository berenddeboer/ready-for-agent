-- CI Repair Work Items are not Issues. Drop the NOT NULL constraints that
-- forced placeholder Issue identity, then clear those placeholders.
-- SQLite cannot drop the historical column defaults without rebuilding the
-- table; inserts must pass NULL explicitly so a default cannot recreate a
-- sentinel. Partial indexes below are valid on SQLite and Postgres.
ALTER TABLE `work_item` ALTER COLUMN `issue_number` DROP NOT NULL;--> statement-breakpoint
ALTER TABLE `work_item` ALTER COLUMN `issue_tracker` DROP NOT NULL;--> statement-breakpoint
ALTER TABLE `work_item` ALTER COLUMN `issue_native_id` DROP NOT NULL;--> statement-breakpoint
ALTER TABLE `work_item` ALTER COLUMN `issue_display_id` DROP NOT NULL;--> statement-breakpoint
ALTER TABLE `work_item` ALTER COLUMN `issue_url` DROP NOT NULL;--> statement-breakpoint
UPDATE `work_item`
SET
  `issue_number` = NULL,
  `issue_tracker` = NULL,
  `issue_native_id` = NULL,
  `issue_display_id` = NULL,
  `issue_url` = NULL
WHERE `origin` = 'ci_repair';--> statement-breakpoint
CREATE UNIQUE INDEX `work_item_one_unfinished_v6_uidx`
  ON `work_item` (`repository_id`, `issue_tracker`, `issue_native_id`)
  WHERE `origin` = 'issue'
    AND "work_item"."state" NOT IN ('complete', 'failed', 'abandoned');--> statement-breakpoint
DROP INDEX IF EXISTS `work_item_one_unfinished_v5_uidx`;--> statement-breakpoint
DROP INDEX IF EXISTS `work_item_repository_issue_created_idx`;--> statement-breakpoint
CREATE INDEX `work_item_repository_issue_created_idx`
  ON `work_item` (`repository_id`, `issue_number`, `created_at`)
  WHERE `origin` = 'issue';--> statement-breakpoint
DROP INDEX IF EXISTS `work_item_repository_native_id_created_idx`;--> statement-breakpoint
CREATE INDEX `work_item_repository_native_id_created_idx`
  ON `work_item` (`repository_id`, `issue_native_id`, `created_at`)
  WHERE `origin` = 'issue';
