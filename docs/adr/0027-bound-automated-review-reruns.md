---
status: accepted
amended-by: 0028
---

# Bound Automated Review Reruns and Reject Non-Review Evidence

Keep individual PR Status Check handoff—persist terminal CheckRun and StatusContext results, batch unhandled ones into Investigate PR Status Checks—but tighten automated-review evidence and put a durable circuit breaker around autonomous whole-review workflow reruns.

Workflow or job names alone (including names containing "review" or "PR Review") are not positive review evidence. Positive evidence requires an executed reviewer job or step, or a comment from a recognized automated reviewer. A skipped workflow or job with no executed reviewer steps and no recognized automated-review comment is not an incomplete review; green-only handoffs with no other relevant review evidence complete as the existing no-op `PROCESSED` path without requesting a rerun.

OpenCode no longer executes whole-review workflow reruns itself. When positive review evidence shows a terminal incomplete review, it reports `READY_FOR_AGENT_RESULT: RERUN_REVIEW: <workflow_run_id> [workflow_name]`. The harness authorizes and executes that request through the GitHub service boundary (`POST .../actions/runs/{id}/rerun`).

## Incomplete Automated Review Output (comment-body detection)

The harness classifies **visibly incomplete** Automated Review Output from the latest correlated recognized-reviewer **comment body**, without requiring an Investigate Agent Turn to rediscover incompleteness each time. The strong pattern is a finished banner plus an unchecked Aggregate-style substantive progress task (for example “Aggregate findings and post review”) and/or missing final synthesis. A successful terminal review with **no** relevant comment remains no feedback (`PROCESSED`); only a **present** incomplete comment is recovery-eligible.

For that incomplete signature on a given `(work_item_id, head_sha, workflow_run_id)`, the harness authorizes at most **one** autonomous whole-workflow recovery rerun. A second identical incomplete outcome on the same scope makes no GitHub call, marks the handoff handled, and enters Needs Human. New incomplete-tagged permits are stored with a durable signature. When deciding whether the one-retry incomplete budget is already spent, **any** prior permit on that scope counts — including legacy null-signature agent `RERUN_REVIEW` rows from before body-parse — so Retry checks after earlier agent-driven incomplete recovery does not authorize another whole-workflow Claude run. Pure incomplete recovery therefore does not open a second budget on top of agent spends for the same incomplete comment. Once an incomplete-tagged permit exists on a scope, further agent-reported `RERUN_REVIEW` for that same scope also enters Needs Human. A new PR head SHA or new workflow run id gets a fresh single incomplete retry. Incomplete classification without a resolvable workflow run id enters Needs Human without an Investigate Agent Turn.

## General autonomous review-rerun budget

The harness persists autonomous review-rerun permits scoped to Work Item, PR head SHA, and workflow run identity. For agent-reported `RERUN_REVIEW`, three reruns are allowed after the initial free execution. A durable permit is reserved before the GitHub call so a crash or indeterminate API result cannot unlock an unbounded extra call after restart. A fourth requested rerun makes no GitHub call, marks the current handoff handled, and enters Needs Human. The budget does not reset on Watch polling, replacement job IDs, a new Step Run, process restart, or operator Retry checks. A new PR head or new workflow run starts a fresh budget. Pushes, ordinary failed-check restarts, `WAITING`, green-only no-ops, and completed reviews do not consume the budget. Exhaustion blocks only another autonomous rerun; after human intervention the same handoff can still complete when the review is complete or no longer needs recovery.

## Operator-facing Needs Human reason language

Needs Human / limit reasons name the automated review **workflow or check** identity clearly (for example workflow `"Claude Code Review"`) and must not read as if the Work Item’s implement Agent Backend or Session model were that product. Prefer phrasing such as `Automated review workflow "Claude Code Review" hit the autonomous rerun limit…` or `…is still incomplete after autonomous recovery was already used on this workflow run…` over bare `for Claude Code Review`.

Replacement check executions remain distinct by external ID. Checks are not deduplicated by display name.

## Consequences

- Green automated-review inspection, the `WAITING` active-review path, red-check diagnostics, FAILED recovery turn, and two-poll failed confirmation remain in force except where this decision replaces direct agent-driven whole-review reruns and unbounded incomplete-review recovery.
- Ordinary CI named like a reviewer can no longer be mistaken for positive review evidence solely from its name.
- Visibly incomplete reviewer comments are recovered once by harness-owned observation; a repeated identical incomplete outcome surfaces Needs Human without further agent diagnosis or full three-rerun spend.
- Broken reviewers that agents keep flagging stop after three autonomous whole-workflow reruns and surface Needs Human instead of looping forever through replacement job IDs.
- Harness GitHub credentials must continue to include Actions write for authorized reruns.
