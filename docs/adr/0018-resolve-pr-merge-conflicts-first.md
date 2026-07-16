---
status: accepted
---

# Resolve PR Merge Conflicts First

Extend Watch PR Status Checks to query pull-request mergeability during every normal poll. A known merge conflict has higher priority than completed status checks: the watch retires every completed, unhandled PR Status Check, then advances to a dedicated Resolve PR Merge Conflict Lifecycle Step. Unknown mergeability preserves unhandled checks and polls again after 30 seconds; an ordinary `BEHIND` branch does not trigger conflict resolution because being up to date is not generally required. Once Watch has selected and queued a status-check handoff, Investigate PR Status Checks trusts that result rather than rechecking mergeability.

Resolve PR Merge Conflict continues the Implement OpenCode Session in two turns using the existing `PROCESSED` / `NEEDS_HUMAN` verdict protocol. OpenCode fetches `origin`, incorporates any remote commits on the PR branch, rebases onto the PR's current base branch, verifies the result, and pushes with `--force-with-lease`; a lease rejection causes one refetch, incorporation, rebase, and push retry before OpenCode reports that human intervention is needed. A processed rebase returns to Watch after the normal 30-second delay so restarted checks are observed afresh.

## Consequences

- Every rebase attempt has its own durable Step Run and is visible separately from status-check investigation.
- Completed check results retired by a conflict are not handed to OpenCode even if the rebase step later fails, because a successful rebase makes those executions obsolete and an unresolved conflict remains the priority.
- Neutral, skipped, cancelled, stale, and pending check results retain their existing behavior and do not need retirement.
