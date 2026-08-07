ALTER TABLE `step_run` ADD `postponed_until` integer;--> statement-breakpoint

-- `postponed_until` is an outcome attribute, not a second Work Item hold.
-- SQLite cannot add a CHECK constraint to an existing table, so enforce the
-- same invariant for both new rows and later outcome updates at the boundary.
CREATE TRIGGER `step_run_postponed_until_insert`
BEFORE INSERT ON `step_run`
WHEN (NEW.`status` = 'postponed' AND (NEW.`finished_at` IS NULL OR NEW.`postponed_until` IS NULL))
  OR (NEW.`status` <> 'postponed' AND NEW.`postponed_until` IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'step_run_postponed_until_invariant');
END;--> statement-breakpoint

CREATE TRIGGER `step_run_postponed_until_update`
BEFORE UPDATE OF `status`, `finished_at`, `postponed_until` ON `step_run`
WHEN (NEW.`status` = 'postponed' AND (NEW.`finished_at` IS NULL OR NEW.`postponed_until` IS NULL))
  OR (NEW.`status` <> 'postponed' AND NEW.`postponed_until` IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'step_run_postponed_until_invariant');
END;
