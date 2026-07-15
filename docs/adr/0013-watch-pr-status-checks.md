# Watch PR Status Checks

After Create PR succeeds, the Work Item enters Watch PR Status Checks instead of completing immediately. The step queries GitHub for the open pull request on the Work Item's deterministic branch. A missing status-check rollup (`no_checks`) is not treated as green: it requeues with a 30-second delay until the Work Item has resided in this step for at least 60 seconds (two poll intervals), after which absence of checks is accepted as green for repos with none configured. Pending rollup states keep polling. An actual SUCCESS rollup advances to Mark PR Ready for Review. Failed checks advance to Investigate PR Status Checks.

Investigate PR Status Checks continues the Implement OpenCode Session with the Repository GitHub credential. OpenCode inspects check logs, fixes, commits, and pushes when possible, then reports a structured outcome. A fix returns to a delayed Watch PR Status Checks run and restarts the 60-second `no_checks` grace. A failure that cannot be fixed autonomously or requires a human decision moves the Work Item to the terminal Needs Human state with OpenCode's reason.

## Consequences

- Every poll and investigation is a separate Step Run, preserving durable execution history and at-least-once queue behavior.
- New Repository credentials request Actions read permission so OpenCode can inspect GitHub Actions check logs.
- A newly created PR that is not yet visible through GitHub is treated as pending; a visible PR with a null rollup is `no_checks` (not green) until the 60-second grace elapses.
- Same-state watch requeues preserve `state_ready_at` so residence time (and the `no_checks` grace) accumulate across polls.
- A merged PR is treated as green and advances to Mark PR Ready for Review (a no-op if already non-draft); a closed, unmerged PR enters Needs Human instead of polling forever.
- Needs Human is terminal and no longer blocks a later Implement Now request for the Issue.
- Green checks no longer complete the Work Item; Mark PR Ready for Review runs next (see ADR 0014).
