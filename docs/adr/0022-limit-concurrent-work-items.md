# Limit concurrent Work Items (Worker Slots)

Harness Config `maxConcurrentWorkItems` (default 5) bounds how many unfinished Work Items may be **Admitted** at once (each occupies one Worker Slot). Operators may still Implement Now / Implement Locally beyond that bound; excess Work Items are **Waiting for Worker Slot** (FIFO by time entered waiting), with no Step Run or lifecycle job until admission. Rejected alternative: reject create when full — operators want to queue freely.

Only Admitted Work Items occupy slots. Waiting, paused, Needs Human, and terminal Work Items do not. A failed non-terminal Step Run releases the slot and does not auto-queue for re-admission; Retry (or Start after Pause) re-acquires, or the Work Item waits if none free. Pause releases after any in-flight Step Run finishes. Refresh-driven resume from Needs Human and Abandon-from-Needs-Human cleanup also re-acquire; plain Abandon of a never-started waiter is immediate.

Waiting for GitHub also releases its Worker Slot. The release immediately runs the ordinary FIFO waiter admission pass before the delayed GitHub wake is due; the later wake re-enters the same admission path for the postponed Lifecycle Step and therefore never bypasses existing Worker Slot waiters.

This is separate from `maxConcurrentAgentTurns` (ADR 0031). The job-worker fiber budget is at least `max(maxConcurrentWorkItems, 2 × maxConcurrentAgentTurns)` so admission is not undercut by fibers. Config is re-read on each admission; raising admits waiters up to the new bound; lowering never demotes already-Admitted Work Items.
