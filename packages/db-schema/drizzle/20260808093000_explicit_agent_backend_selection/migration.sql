ALTER TABLE `config` ADD `agent_backend_configured_at` integer;--> statement-breakpoint

-- Preserve existing installations' established preflight behavior. New
-- databases run this migration before their config row is created, leaving the
-- marker null until Settings explicitly saves an Agent Backend.
UPDATE `config`
SET `agent_backend_configured_at` = `updated_at`
WHERE `agent_backend_configured_at` IS NULL;
