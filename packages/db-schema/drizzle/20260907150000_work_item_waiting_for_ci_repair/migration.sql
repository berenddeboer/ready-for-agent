-- Durable Waiting for CI Repair hold (distinct from Waiting for blockers and
-- Waiting for Worker Slot). Existing Work Items migrate with no hold.
ALTER TABLE `work_item` ADD `waiting_for_ci_repair` integer DEFAULT false NOT NULL;
