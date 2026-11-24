ALTER TABLE `work_item` ADD `spec_validation_key` text;--> statement-breakpoint
ALTER TABLE `work_item` ADD `spec_validation_input` text;--> statement-breakpoint
ALTER TABLE `work_item` ADD `spec_validation_findings` text;--> statement-breakpoint
CREATE UNIQUE INDEX `work_item_spec_validation_uidx`
  ON `work_item` (`repository_id`, `spec_validation_key`);
