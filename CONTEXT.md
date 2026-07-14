# Ready for Agent

Opinionated agentic software engineering harness that works GitHub issues into PRs for configured repositories.

## Language

**Repository**:
A GitHub repository the harness is configured to work on, identified by owner and name (case-insensitive identity; display casing preserved). One row per GitHub repo; the harness keeps a single local clone of it (bare or working). Displayed as `owner/name` — no separate display label.
_Avoid_: Repo (in formal docs), target, project, checkout

**Paused**:
A Repository state in which the harness does not autonomously select work for the Repository while keeping its configuration. Explicit operator requests, including a manual Refresh Job or Implement Now and its resulting lifecycle, remain allowed; new Repositories start paused until deliberately unpaused.
_Avoid_: Disabled, inactive, enabled=false

**Issue**:
A GitHub issue belonging to a Repository, identified within that Repository by a positive integer GitHub issue number and represented locally with its title, body, web URL, creation time, and GitHub state. The harness may retain a local representation for later use, but GitHub remains authoritative.
_Avoid_: Ticket, task (unless referring to a broader concept)

**Issue store**:
The harness capability that retains the Repository's current working set of Relevant Issue representations locally. It does not fetch, refresh, or establish the authoritative state of Issues.

**Issue Reconciler**:
The sole harness capability that changes the Issue store, deriving one Repository's Relevant Issues from GitHub's authoritative set of Ready-labeled Issues. Issues that are not Relevant, including Issues whose ready label was removed, are absent from the Issue store after reconciliation.
_Avoid_: GitHub Reconciler (too broad), Issue Synchronizer (suggests bidirectional updates)

**Refresh Job**:
A durable request for the Issue Reconciler to reconcile one Repository. Acceptance of a Refresh Job does not mean reconciliation has completed.
_Avoid_: Refresh (ambiguous between the request and its execution), sync job

**Keymaxxer Service**:
The backend boundary for vault operations. It can determine whether a named secret exists, request that a secret be added, and run a command with named secrets injected without exposing raw secret values to the Harness.
_Avoid_: Secret store, credential cache

**Keymaxxer Sidecar**:
A development-only companion process that owns the Keymaxxer MCP session so watched application-server reloads do not repeat vault-unlock or secret-use approval prompts.
_Avoid_: Credential daemon, token cache

**Session**:
An opencode conversation identified by opencode’s session id, scoped to a working directory, and continued across one or more prompt runs.
_Avoid_: chat, thread, conversation (in formal docs)

**Ready-labeled Issue**:
An Issue carrying the `ready-for-agent` GitHub label, regardless of whether the Issue is open or closed. A fetched Ready-labeled Issue includes its number, title, body, web URL, creation time, and GitHub state so consumers can decide whether it is actionable.
_Avoid_: Ready Issue (can imply that the Issue is open and actionable)

**Supported Issue Hierarchy**:
A GitHub issue hierarchy wholly contained within one Repository and limited to a root Issue with optional direct children. A hierarchy containing a cross-Repository relationship or a grandchild is unsupported in its entirety.
_Avoid_: Issue tree (implies arbitrary depth), nested Issues

**Parent Issue**:
A root Issue with one or more direct children. It organizes related work but is not itself a unit the harness works directly.
_Avoid_: PRD (the relationship does not establish document type), epic

**Child Issue**:
A direct child of a Parent Issue. In a Supported Issue Hierarchy, a Child Issue has no children of its own.
_Avoid_: Subtask, nested Issue

**Standalone Issue**:
A root Issue with no children. It is structurally eligible to be worked directly.
_Avoid_: Unparented Issue, top-level Issue

**Leaf Issue**:
An Issue with no children: either a Standalone Issue or a Child Issue. Only Leaf Issues are structurally eligible to be worked directly, subject to other workflow constraints.
_Avoid_: Actionable Issue (actionability also depends on workflow constraints)

**Work Item**:
A durable record of one operator-requested attempt to work a Leaf Issue through the implementation lifecycle, using the OpenCode model and variant captured at creation. It references the current Issue by Repository and GitHub issue number without snapshotting its contents; a Leaf Issue may produce multiple Work Items over time, but at most one may be unfinished at a time.
_Avoid_: Issue lifecycle, implementation job, attempt

**Implement Now**:
An explicit operator request that creates a Work Item for a Leaf Issue. Work Items are not created automatically by Issue reconciliation or eligibility discovery.
_Avoid_: Auto-implement, enqueue Issue

**Not Implemented**:
The derived status of an Issue for which no Work Item has ever been created. It is not a persisted Work Item lifecycle state.
_Avoid_: Pending, queued

**Implementable Issue**:
A current, open Leaf Issue with no listed blockers. A Work Item revalidates this predicate before every lifecycle advancement and fails terminally if the predicate no longer holds.
_Avoid_: Ready-labeled Issue, Relevant Issue, Leaf Issue

**Actionable Issue**:
An Implementable Issue with no unfinished Work Item. Only an Actionable Issue may receive Implement Now; Repository pause does not affect actionability.
_Avoid_: Not Implemented Issue, Ready-labeled Issue

**Lifecycle Step**:
The next action required for a Work Item: Create Worktree, Install Dependencies, Implement, Review, or a terminal Complete, Failed, or Abandoned state. A successful step advances the Work Item; a failed step leaves the same action pending.
_Avoid_: Last completed step, phase

**Step Run**:
A durable record of one scheduled execution attempt for a Work Item's Lifecycle Step, created when that attempt is queued and recording when it starts, finishes, and succeeds, fails, is interrupted, or is cancelled before starting. Retried steps produce additional Step Runs rather than replacing earlier attempts, allowing queue wait and execution duration to be measured separately.
_Avoid_: Step duration, job attempt

**Retry**:
An explicit operator request to create a new Step Run for a Work Item whose previous run failed. Lifecycle failures are not retried automatically.
_Avoid_: Queue redelivery, resume

**Abandon**:
An operator-directed transition that moves a Work Item with no running Step Run to the terminal Abandoned state while preserving its history. Repository removal may apply it automatically to non-running Work Items before deleting that Repository's lifecycle history; an Abandoned Work Item no longer prevents a later Implement Now request for the same Issue.
_Avoid_: Delete, cancel

**Reset**:
An operator-directed erasure of a Work Item that stops queued or running Step Runs, removes the Git worktree and branch, and deletes the Work Item and its Step Run history so the Issue returns to Not Implemented. Unlike Abandon, Reset does not preserve history.
_Avoid_: Abandon, Retry, cancel

**Failed Work Item**:
A terminal Work Item that cannot advance because a lifecycle precondition, such as the referenced Issue still existing, was not met. Its Step Run retains the outcome of the Effect itself, and the Work Item records the separate failure reason.
_Avoid_: Failed Step Run, Abandoned

**Complete Work Item**:
A terminal Work Item for which Create Worktree, Install Dependencies, Implement, and Review all executed successfully. Complete does not mean review approved the changes, a pull request exists, or GitHub closed the Issue.
_Avoid_: Approved, merged, done Issue

**Relevant Issue**:
A Ready-labeled Issue in a Supported Issue Hierarchy that remains pertinent to the harness: either an open root Issue, or a direct child whose parent is open and Ready-labeled. A closed root Issue, or a child with a closed or non-Ready-labeled parent, is not relevant.
_Avoid_: Active Issue (a Relevant Issue may be closed), Actionable Issue (actionability also depends on workflow constraints), Visible Issue (presentation-specific)
