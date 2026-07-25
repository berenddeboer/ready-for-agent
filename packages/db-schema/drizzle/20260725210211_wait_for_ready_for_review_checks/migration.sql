-- Default true preserves current Ready-Phase Status Check Round behavior.
ALTER TABLE `repository` ADD `wait_for_ready_for_review_checks` integer DEFAULT true NOT NULL;
