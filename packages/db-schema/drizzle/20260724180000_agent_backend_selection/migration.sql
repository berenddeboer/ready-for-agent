ALTER TABLE `config` ADD `selected_agent_backend` text DEFAULT 'opencode' NOT NULL;--> statement-breakpoint
UPDATE `config` SET `selected_agent_backend` = 'opencode' WHERE `selected_agent_backend` IS NULL OR trim(`selected_agent_backend`) = '';--> statement-breakpoint
ALTER TABLE `work_item` ADD `agent_backend` text DEFAULT 'opencode' NOT NULL;--> statement-breakpoint
UPDATE `work_item` SET `agent_backend` = 'opencode' WHERE `agent_backend` IS NULL OR trim(`agent_backend`) = '';
