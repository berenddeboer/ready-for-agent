# Parent Implement all with auto-merge via durable Work Item Merge Mode

Operators need one Parent Issue action that implements open children and records an explicit merge choice that does not re-ask Decide PR Merge. Parent implementation is an **atomic bulk command over ordinary child Work Items**, not a parent-level lifecycle or durable batch. Unconditional merge is a **Work Item Merge Policy pin** of `always` (encoded as Merge Mode `always`). Repository Merge Policy may also be `always` as a live default (ADR 0059); Auto-merge is only this parent command.

Always skips only Decide PR Merge after the normal pre-merge lifecycle settles. Pending, failed, and Expected checks, automated-review handling, conflict resolution, Merge PR revalidation, Forge requirements, technical Needs Human outcomes, Retry, Refresh reconciliation, and No-Change Outcome Close Issue remain unchanged. After the Check-Start Deadline, `no_checks` is green for Always and not for Classify (ADR 0059); ADR 0055 still applies to Classify and to every non-`no_checks` aggregate. Existing and ordinary new Work Items remain unpinned unless Implement With or this command writes a pin. The Parent Issue receives no Work Item and is never closed or updated by this command.

## Consequences

- Child Work Items remain independent under the global Worker Slot limit; siblings may run concurrently.
- Enrollment is atomic: failure creates no partial Work Items or Merge Policy pins.
- Open children without unfinished Work Items are enrolled together (Implement Now or Queue); existing unfinished child Work Items are adopted in the same atomic request by pinning Always without reset or duplication.
- A merge-related Needs Human handoff on an adopted Work Item remains stopped; pinning Always does not clear the handoff or enqueue Merge PR.
