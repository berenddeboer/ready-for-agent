---
status: accepted
supersedes: 0016-handoff-individual-pr-status-checks
---

# Bound Automated Review Reruns and Reject Non-Review Evidence

Keep the Status Check Handoff model from ADR 0016, but tighten automated-review evidence and put a durable circuit breaker around autonomous whole-review workflow reruns.

Workflow or job names alone (including names containing "review" or "PR Review") are not positive review evidence. Positive evidence requires an executed reviewer job or step, or a comment from a recognized automated reviewer. A skipped workflow or job with no executed reviewer steps and no recognized automated-review comment is not an incomplete review; green-only handoffs with no other relevant review evidence complete as the existing no-op `PROCESSED` path without requesting a rerun.

OpenCode no longer executes whole-review workflow reruns itself. When positive review evidence shows a terminal incomplete review, it reports `READY_FOR_AGENT_RESULT: RERUN_REVIEW: <workflow_run_id> [workflow_name]`. The harness authorizes and executes that request through the GitHub service boundary (`POST .../actions/runs/{id}/rerun`).

The harness persists autonomous review-rerun permits scoped to Work Item, PR head SHA, and workflow run identity. Three reruns are allowed after the initial free execution. A durable permit is reserved before the GitHub call so a crash or indeterminate API result cannot unlock an unbounded extra call after restart. A fourth requested rerun makes no GitHub call, marks the current handoff handled, and enters Needs Human with a concise workflow/count reason. The budget does not reset on Watch polling, replacement job IDs, a new Step Run, process restart, or operator Retry checks. A new PR head or new workflow run starts a fresh budget. Pushes, ordinary failed-check restarts, `WAITING`, green-only no-ops, and completed reviews do not consume the budget. Exhaustion blocks only another autonomous rerun; after human intervention the same handoff can still complete when the review is complete or no longer needs recovery.

Replacement check executions remain distinct by external ID. Checks are not deduplicated by display name.

## Consequences

- ADR 0016's green automated-review inspection, `WAITING` active-review path, red-check diagnostics, FAILED recovery turn, and two-poll failed confirmation remain in force except where this decision replaces direct agent-driven whole-review reruns and unbounded incomplete-review recovery.
- Ordinary CI named like a reviewer can no longer be mistaken for positive review evidence solely from its name.
- Broken reviewers stop after three autonomous whole-workflow reruns and surface Needs Human instead of looping forever through replacement job IDs.
- Harness GitHub credentials must continue to include Actions write for authorized reruns.
