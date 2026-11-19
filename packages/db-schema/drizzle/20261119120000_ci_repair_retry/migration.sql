-- Durable CI Repair retry request so a restart can re-observe before dispatching.
ALTER TABLE `work_item` ADD `ci_repair_retry` text;
