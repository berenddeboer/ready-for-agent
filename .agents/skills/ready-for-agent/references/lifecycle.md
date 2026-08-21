# Work Item lifecycle reference

The vocabulary below is generated from a versioned ontology (`ontology/rfa.ttl`
in the harness source), so these names are exact — they appear verbatim in
GraphQL responses, CLI JSON, and the UI.

## Contents

- [State vs status](#state-vs-status)
- [Lifecycle states](#lifecycle-states)
- [Statuses](#statuses)
- [Kanban lanes](#kanban-lanes)
- [Source windows](#source-windows-why-work-disappears)
- [Step Run reason codes](#step-run-reason-codes)
- [Failure codes](#failure-codes)
- [Operator actions](#operator-actions)

## State vs status

A Work Item carries both, and reporting either alone is misleading.

- **State** — where it is in the lifecycle (`IMPLEMENT`, `REVIEW`, `MERGE_PR`).
- **Status** — how the current step is going (`RUNNING`, `FAILED`, `QUEUED`).

`IMPLEMENT/RUNNING` is healthy work in progress. `IMPLEMENT/FAILED` is a
stopped attempt. `IMPLEMENT/NEEDS_HUMAN` is a handoff. Always report the pair.

`stateResidenceMs` is how long it has sat in the current state — the single most
useful number for spotting a stall.

**`lifecycleLabels` is per phase, not per attempt.** Its `status` is the latest
attempt's outcome and `durationMs` is the sum over all attempts, so a retried
step hides its earlier failures. Verified example: a 49.96-minute failed
Implement plus a 3.6-minute successful retry renders as one
`IMPLEMENT SUCCEEDED 3213281ms`. For real per-attempt history read the
`step_run` table in `~/.local/share/ready-for-agent/ready-for-agent.db`
(columns `step`, `status`, `reason_code`, `started_at`, `finished_at`) — open it
read-only, and note the harness runs in WAL mode, so copy the `-wal` file too or
query the original with a read-only URI rather than copying the `.db` alone.
The `autonomous_retry` table records budget-tracked retries.

## Lifecycle states

In lifecycle order. Each maps to the lane shown.

| State | Lane | What happens |
| --- | --- | --- |
| `CREATE_WORKTREE` | Build | Fresh git worktree for this attempt |
| `INSTALL_DEPENDENCIES` | Build | Package install in the worktree |
| `IMPLEMENT` | Build | **Agent turn** — writes the implementation |
| `ASSESS_CHANGES` | Build | Harness checks whether anything actually changed |
| `PRE_COMMIT` | Build | Pre-commit hooks / checks |
| `REVIEW` | Review | **Agent turn** — local code review, may loop applying findings |
| `COMMIT` | PR | **Agent turn** for commit copy, then the native commit |
| `CREATE_PR` | PR | Opens the pull request |
| `WATCH_PR_STATUS_CHECKS` | PR | Polls CI (`QUEUED` here is normal, not stuck) |
| `RESOLVE_PR_MERGE_CONFLICT` | PR | **Agent turn** — resolves conflicts |
| `INVESTIGATE_PR_STATUS_CHECKS` | PR | **Agent turn** — diagnoses failing CI |
| `MARK_PR_READY_FOR_REVIEW` | PR | Flips draft → ready |
| `DECIDE_PR_MERGE` | PR | **Agent turn** — risk classification for autonomous merge |
| `MERGE_PR` | PR | Performs the merge |
| `CLOSE_ISSUE` | PR | Closes the issue when the merge did not |
| `LOCAL_CLEANUP` | PR | Removes worktree and branch |

Terminal states:

| State | Lane | Meaning |
| --- | --- | --- |
| `COMPLETE` | Merged | Succeeded end to end |
| `ABANDONED` | Merged | Deliberately given up, history preserved |
| `FAILED` | Attention | Terminal failure |
| `NEEDS_HUMAN` | Attention | Harness stopped and handed back, with a reason |

Steps marked **agent turn** invoke the coding-agent CLI and routinely take
minutes to hours. Do not treat their duration as a stall on its own.

## Statuses

| Status | Meaning |
| --- | --- |
| `QUEUED` | Step enqueued, not yet running. Normal; not stuck |
| `RUNNING` | Executing now |
| `SUCCEEDED` | Step finished cleanly |
| `FAILED` | Step failed. Often retryable — check `canRetry` |
| `INTERRUPTED` | Stopped mid-run (Interrupt Work Item, or worker restart) |
| `CANCELLED` | Cancelled before completion |
| `POSTPONED` | Deferred to `retryAt`. Retry is unavailable until then |
| `COMPLETE` | Terminal success |
| `ABANDONED` | Terminal abandonment |
| `NEEDS_HUMAN` | Handoff to the operator |
| `NEEDS_HUMAN_REVIEW` | Handoff specifically for human code review |
| `WAITING_FOR_WORKER_SLOT` | Admitted, waiting for concurrency capacity |
| `WAITING_FOR_BLOCKERS` | Blocked by other issues; no worktree yet |
| `WAITING_FOR_GITHUB` | Waiting on the forge (often rate limiting) |

## Kanban lanes

Lane assignment is a pure function of state and status:

1. **Attention and Merged win over everything.** Status `FAILED`,
   `INTERRUPTED`, `NEEDS_HUMAN`, or `NEEDS_HUMAN_REVIEW`, or state `FAILED` /
   `NEEDS_HUMAN` → **Attention**, regardless of how far the lifecycle got.
   `COMPLETE` / `ABANDONED` → **Merged**.
2. **Queue is only genuine holds** — `WAITING_FOR_BLOCKERS` and
   `WAITING_FOR_WORKER_SLOT`.
3. Otherwise the lifecycle state decides Build / Review / PR. A `QUEUED` status
   on a later step keeps the item in its current lane; it never falls back to
   Queue.

So a Work Item that reached `MERGE_PR` but went Needs Human reports in
**Attention**, not PR. Its lifecycle chips still show how far it got.

## Source windows (why work disappears)

The shared projection behind `ready-for-agent status`, `kanbanStatus`, and the
board is deliberately windowed:

- **Working** — every unfinished Work Item, plus retryable failures and Needs
  Human handoffs. No cap.
- **Failed** — only the newest **15** non-retryable terminal failures, ordered
  by creation. Older ones drop off.
- **Completed** — `COMPLETE` / `ABANDONED` only if terminal within the last
  **24 hours**.

On top of that, the repo-wide `workItems` query filters to items that are in a
completed state, or working, **or whose issue is still in the relevant-issue
store**. A terminal-failed Work Item whose issue was closed or unlabelled on the
forge satisfies none of these and becomes invisible to every repo-wide listing.

Querying `workItems(repositoryId:, issueNumber:)` bypasses the visibility filter
and still returns it. This is the only reliable way to answer "what happened to
issue N".

For real throughput use `committedPullRequestsCount` and `completedWorkItems`
(a full paginated archive, no 24-hour window).

## Step Run reason codes

The complete vocabulary. `latestStepRunReason.code` carries one of these.

**Mid-run progress** (informational — the step is working, not stuck):

| Code | Meaning |
| --- | --- |
| `native` | Step is doing its non-agent native work |
| `waiting_for_agent_turn` | Queued for an agent-turn slot |
| `copy_generation` | Commit is generating PR/commit copy via an agent turn |
| `review_reviewing` | Review pass in progress |
| `review_assessing_rerun` | Deciding whether another review round is needed |
| `review_applying_findings` | Applying review findings |
| `review_pre_commit` | Pre-commit work inside review |
| `review_deferred` | Review deferred |
| `agent_fallback` | Native path missed its postcondition; one repair agent turn ran |

**Clean outcomes:**

| Code | Meaning |
| --- | --- |
| `review_clean` / `review_cleared` | Review found nothing blocking |
| `review_accepted` | Review findings accepted |
| `pr_merged` | PR merged |
| `merge_revalidation` | Merge preconditions being revalidated |
| `green-no-review-evidence` | CI green, but no positive automated-review evidence found |

**Stops needing a decision:**

| Code | Meaning | Action |
| --- | --- | --- |
| `handler_failed` | The step's handler failed — most commonly the agent returned a malformed `READY_FOR_AGENT_RESULT`, or exited non-zero | Retry; repeated failures indict the model |
| `handler_defect` | Internal harness defect | Report it; retry rarely helps |
| `timeout` | Step exceeded its budget | Retry |
| `interrupted` | Interrupted mid-run | Retry once Pause is cleared |
| `worker_restarted` | Harness restarted under it | Retry |
| `paused` | Operator paused it | Start, then Retry |
| `abandoned` | Operator abandoned it | Terminal |
| `reset` | Operator reset it | Work Item is gone |
| `agent_backend_unavailable` | Backend CLI missing or broken | Fix PATH/auth, Recheck |
| `agent_backend_auth_rejected` | Credentials missing, expired, invalid | Re-authenticate the CLI |
| `agent_model_not_in_catalog` | Configured model absent from the live catalog | Pick a current model |
| `thinking_level_not_in_catalog` | Configured effort absent from the catalog | Pick a current effort |
| `build_model_not_configured` | No build model configured | Set one in Settings |
| `github_throttled` | Rate limited; stopped at GitHub's retry time | Wait for `retryAt` |
| `missing_successful_checks` | Autonomous merge required green CI, did not get it | Retryable |
| `pr_status_checks_unresolved` | Status checks never resolved | Retryable |
| `issue_closed_while_pr_open` | Issue closed while its PR is still open | Human decision |
| `issue_closed_pr_closed_unmerged` | Issue closed, PR closed unmerged | Human decision |

## Failure codes

`failureCode` on a terminal Work Item:

| Code | Meaning |
| --- | --- |
| `issue_not_found` | The issue left the relevant-issue store mid-flight (closed, unlabelled, or deleted). The attempt is abandoned; nothing to repair locally |
| `issue_closing_pull_request_unowned` | Another open PR already closes this issue and this Work Item does not own it. Review that PR, then Reset |
| `pr_status_checks_unresolved` | Legacy terminal record; still retryable — restores status-check watching |

## Operator actions

| Action | Reversible | What it does |
| --- | --- | --- |
| **Retry** | yes | New Step Run; keeps worktree, branch, PR, session. Must re-acquire a worker slot. Rejected while paused or postponed |
| **Start** | yes | Clears Pause and resumes the current step |
| **Pause** | yes | Marks the item paused; does **not** interrupt a running step. Cancels queued steps |
| **Interrupt** | yes | Stops a *running* step on an already-paused item; keeps worktree and session |
| **Abandon** | no | Terminal give-up; **preserves** history |
| **Reset** | **no** | Stops runs, deletes worktree and branch, erases the Work Item and all Step Run history. Issue returns to Not Implemented |

**Autonomous Retry Budget:** `--all-retryable` retries are capped (default 3 per
Work Item at its current step) and report `LIMIT_REACHED` on exhaustion. The
budget resets only when the item advances to a different step. Explicit
single-issue, single-work-item, and UI retries are not capped.
