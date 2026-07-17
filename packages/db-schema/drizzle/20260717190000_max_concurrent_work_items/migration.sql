ALTER TABLE `config` ADD `max_concurrent_work_items` integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE `work_item` ADD `waiting_since` integer;--> statement-breakpoint
ALTER TABLE `work_item` ADD `holds_worker_slot` integer DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE `work_item`
SET `holds_worker_slot` = 1
WHERE `state` NOT IN ('complete', 'failed', 'abandoned', 'needs_human')
  AND EXISTS (
    SELECT 1 FROM `step_run`
    WHERE `step_run`.`work_item_id` = `work_item`.`id`
      AND `step_run`.`status` IN ('queued', 'running')
  );
