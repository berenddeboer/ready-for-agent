-- Queue hold: Waiting for blockers (distinct from Waiting for Worker Slot).
ALTER TABLE `work_item` ADD `waiting_for_blockers` integer DEFAULT false NOT NULL;
