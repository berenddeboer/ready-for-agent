CREATE INDEX `work_item_complete_ready_at_idx` ON `work_item` (`state_ready_at`) WHERE `state` = 'complete';
