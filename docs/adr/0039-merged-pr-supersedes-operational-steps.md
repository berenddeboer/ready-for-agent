# Merged Work Item PR supersedes unfinished operational steps

A confirmed merged Work Item PR supersedes every unfinished operational Lifecycle Step and any Needs Human handoff that still owns that PR. Refresh (manual or scheduled Issue Polling) inspects Work Item PR lifecycle status for unfinished Work Items with a recorded PR. Merged → interrupt any running Step Run and wait for in-process execution to stop, cancel queued Step Runs, advance to local cleanup (retaining or reacquiring a Worker Slot), then Complete. Closing the linked Issue as part of the merge must not produce `issue_not_open` or `issue_not_found`. After harness restart, prior-process interrupt does not requeue obsolete operational work; the next successful Refresh discovers the merge and advances cleanup. Closed-unmerged Abandon remains limited to merge-related Needs Human (Decide PR Merge / Merge PR), as before.

## Consequences

- Refresh is the automatic merge-outcome seam for both Needs Human merge handoffs and mid-loop operational steps (Watch, Investigate, and peers).
- When a Work Item already owns a PR and Issue revalidation reports only `issue_not_open` / `issue_not_found`, the Step Run may succeed without failing the Work Item, but Complete still requires a confirmed merged PR (Refresh / `continueAfterHumanPrOutcome`). “Has a PR number” alone never Completes.
- Startup orphan recovery still marks prior-process Running Step Runs Interrupted without redelivery; merge discovery is Refresh-driven, not silent requeue.
- Step Run history retains interrupted/cancelled outcomes with reason `pr_merged` for superseded work.
