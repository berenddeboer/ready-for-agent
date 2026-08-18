-- Replace Repository Auto-merge boolean with three-state Merge Policy.
-- enabled (1) → classify; disabled (0) → off. New Repositories default to off.
ALTER TABLE `repository` ADD `merge_policy` text DEFAULT 'off' NOT NULL;
--> statement-breakpoint
UPDATE `repository` SET `merge_policy` = CASE WHEN `auto_merge` = 1 THEN 'classify' ELSE 'off' END;
--> statement-breakpoint
ALTER TABLE `repository` DROP COLUMN `auto_merge`;
