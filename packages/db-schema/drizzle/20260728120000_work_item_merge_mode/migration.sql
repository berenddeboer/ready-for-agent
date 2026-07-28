-- Durable Work Item Merge Mode. Existing rows become ordinary (current behavior).
ALTER TABLE `work_item` ADD `merge_mode` text DEFAULT 'ordinary' NOT NULL;
