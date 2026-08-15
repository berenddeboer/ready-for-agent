# Parent Implement all with auto-merge via durable Work Item Merge Mode

Operators need one Parent Issue action that implements open children and records an explicit merge choice that does not re-ask Decide PR Merge. Parent implementation is an **atomic bulk command over ordinary child Work Items**, not a parent-level lifecycle or durable batch. Unconditional merge is a **durable Work Item Merge Mode** (`always`), not a Repository setting change and not transient request data.

Merge Mode `always` skips only Decide PR Merge after the normal pre-merge lifecycle settles. Status checks, automated-review handling, conflict resolution, Merge PR revalidation, GitHub requirements, technical Needs Human outcomes, Retry, Refresh reconciliation, and No-Change Outcome Close Issue remain unchanged. An absent, Expected, pending, or failed status-check aggregate does not satisfy Merge PR and cannot be bypassed by skipping the merge-risk Agent Turn (ADR 0055). Existing and ordinary new Work Items use Merge Mode `ordinary` (Repository Auto-merge + Decide PR Merge). The Parent Issue receives no Work Item and is never closed or updated by this command.

## Consequences

- Child Work Items remain independent under the global Worker Slot limit; siblings may run concurrently.
- Enrollment is atomic: failure creates no partial Work Items or Merge Mode updates.
- Open children without unfinished Work Items are enrolled together (Implement Now or Queue); existing unfinished child Work Items are adopted in the same atomic request by setting Merge Mode Always without reset or duplication.
- A merge-related Needs Human handoff on an adopted Work Item remains stopped; setting Merge Mode Always does not clear the handoff or enqueue Merge PR.
