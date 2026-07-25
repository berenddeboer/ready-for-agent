-- Null selected_agent_backend means inherit the harness default Agent Backend.
ALTER TABLE `repository` ADD `selected_agent_backend` text;
