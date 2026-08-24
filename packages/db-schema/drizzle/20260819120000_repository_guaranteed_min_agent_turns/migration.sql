-- Null guaranteed_min_concurrent_agent_turns means no guarantee: this
-- Repository is admitted under ordinary fair-share Agent Turn rotation only.
ALTER TABLE `repository` ADD `guaranteed_min_concurrent_agent_turns` integer;
