---
status: superseded
superseded-by: 0028
---

# Watch PR Status Checks

After Create PR succeeds, the Work Item enters Watch PR Status Checks instead of completing immediately. The step queries GitHub for the open pull request on the Work Item's deterministic branch. A missing status-check rollup (`no_checks`) is not treated as green: it requeues with a 30-second delay until the Work Item has resided in this step for at least 60 seconds (two poll intervals), after which absence of checks may be accepted. Pending rollup states keep polling. A SUCCESS rollup (or `no_checks` after the grace) does not advance immediately: it requeues once more after 30 seconds and only advances to Mark PR Ready for Review after a second consecutive green poll, so a brief SUCCESS cannot race into merge while another check is still starting. Failed checks advance to Investigate PR Status Checks when an unhandled execution is available. When every observed execution is already handled and the aggregate remains failed for two consecutive Watch runs, the second run stops as a retryable failed Step Run instead of polling forever.

Investigate PR Status Checks continues the Implement OpenCode Session with the Repository GitHub credential. Before the work turn, the harness loads diagnostics for unhandled red PR Status Checks (preferring Actions job logs for `actions-job:<id>` identities; Checks API 403 is expected for fine-grained PATs). OpenCode uses those artifacts first, fixes, commits, and pushes when possible, then reports a structured outcome. Credential or API failure while loading diagnostics fails the Step Run (Retry-eligible) rather than Needs Human. A processed fix or restart returns to a delayed Watch PR Status Checks run and restarts the 60-second `no_checks` grace. A first structured failed verdict triggers one focused recovery turn and another verdict. If recovery still cannot act, Investigate stops as a retryable failed Step Run, preserves the PR and worktree, and directs the operator to fix or rerun checks on GitHub before choosing Retry checks. Only a genuine human decision moves the Work Item to Needs Human.

## Consequences

- Every poll and investigation is a separate Step Run, preserving durable execution history and at-least-once queue behavior.
- New Repository credentials request Actions read and write and Commit statuses read (not Checks; fine-grained PATs cannot grant Checks). Terminal PR Status Checks load via REST Checks with Actions-jobs fallback on 403, plus commit statuses. Actions write lets agents rerun terminal incomplete review workflows; Actions read also lets the harness download job logs for Status Check Handoff diagnostics. Already-created repository tokens are not upgraded automatically — operators must edit the token on GitHub or recreate it and store the replacement in Keymaxxer.
- A newly created PR that is not yet visible through GitHub is treated as pending; a visible PR with a null rollup is `no_checks` (not green) until the 60-second grace elapses.
- Same-state watch requeues preserve `state_ready_at` so residence time (and the `no_checks` grace) accumulate across polls.
- A merged PR is treated as green and advances to Mark PR Ready for Review (a no-op if already non-draft); a closed, unmerged PR enters Needs Human instead of polling forever.
- Needs Human is terminal and no longer blocks a later Implement Now request for the Issue.
- Green checks no longer complete the Work Item; Mark PR Ready for Review runs next (see ADR 0014).
