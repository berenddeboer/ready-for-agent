ALTER TABLE `work_item` ADD `check_start_anchor_at` integer;--> statement-breakpoint
ALTER TABLE `work_item` ADD `check_start_anchor_head_sha` text;--> statement-breakpoint
ALTER TABLE `work_item` ADD `check_start_observed_head_sha` text;--> statement-breakpoint
ALTER TABLE `work_item` ADD `check_start_observed_head_at` integer;--> statement-breakpoint
-- Existing unfinished Work Items, and retryable legacy status-check failures,
-- get a migration-time Check-Start Anchor so a later historical PR creation/push
-- time cannot make the catch-up window already elapsed on first post-upgrade
-- Watch (or Retry back into Watch). Millisecond epoch from integer seconds plus
-- the three fractional-second digits (no julianday float truncation).
UPDATE `work_item`
SET `check_start_anchor_at` = (
  SELECT
    (CAST(strftime('%s', ts) AS integer) * 1000)
    + CAST(substr(strftime('%f', ts), -3) AS integer)
  FROM (SELECT strftime('%Y-%m-%d %H:%M:%f', 'now') AS ts)
)
WHERE `check_start_anchor_at` IS NULL
  AND (
    `state` NOT IN ('complete', 'failed', 'abandoned')
    OR (
      `state` = 'failed'
      AND `failure_code` = 'pr_status_checks_unresolved'
    )
  );
