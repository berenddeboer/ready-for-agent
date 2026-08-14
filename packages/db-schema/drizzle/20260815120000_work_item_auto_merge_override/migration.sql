-- Nullable Work Item Auto-merge override. Existing rows stay null
-- (follow the live Repository Auto-merge setting).
ALTER TABLE `work_item` ADD `auto_merge_override` integer;
