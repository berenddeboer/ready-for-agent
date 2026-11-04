# CI Gate freshness is not historical coverage

A stale polling cursor made every observation scan backward under one timeout, so a current default-branch failure was discarded until that scan finished. Latest Observation and Historical Coverage stay separate: the newest page is committed and can start automatic CI Repair before any historical request, and catch-up walks a fixed gap one page at a time from a durable checkpoint. Increasing the timeout, deleting the cursor, or calling unscanned history complete does not fix that.
