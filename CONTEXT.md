# Ready for Agent

Opinionated agentic software engineering harness that works GitHub issues into PRs for configured repositories.

## Language

**Repository**:
A GitHub repository the harness is configured to work on, identified by owner and name (case-insensitive identity; display casing preserved). One row per GitHub repo; the harness keeps a single local clone of it (bare or working). Displayed as `owner/name` — no separate display label.
_Avoid_: Repo (in formal docs), target, project, checkout

**Paused**:
A Repository state in which the harness does not autonomously select work for the Repository while keeping its configuration. Explicit operator requests, including a manual Refresh Job or Implement Now and its resulting lifecycle, remain allowed; new Repositories start paused until deliberately unpaused.
_Avoid_: Disabled, inactive, enabled=false

**Repository settings**:
Per-Repository operator preferences: Paused, optional build model and variant (null falls back to harness defaults), optional review model and variant (null falls back to harness review settings, then the build model/variant), and Auto-merge. Changing settings does not rewrite existing Work Items; build and review model/variant are captured when a Work Item is created.
_Avoid_: Project config, repo config file

**Auto-merge**:
A Repository setting that, when enabled, lets Decide PR Merge ask whether a clanker may merge a low-risk PR; when disabled, Decide PR Merge always requires a human. Enabling Auto-merge does not itself merge pull requests.
_Avoid_: Automerge (GitHub product), auto-approve

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
The long-lived loopback companion process that owns one Keymaxxer stdio keyholder and exposes the Keymaxxer MCP tools over Streamable HTTP so Harness and every OpenCode process share one vault session and Allow-session set without ambient secret values.
_Avoid_: Credential daemon, token cache, development-only sidecar

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
A durable record of one operator-requested attempt to work a Leaf Issue through the implementation lifecycle, using the OpenCode build model/variant and review model/variant captured at creation. The build model is used for implement and related steps; the review model is used only for the Review step (and falls back to the build model when unset). It references the current Issue by Repository and GitHub issue number without snapshotting its contents; a Leaf Issue may produce multiple Work Items over time, but at most one may be unfinished at a time.
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
The next action required for a Work Item: Create Worktree, Install Dependencies, Implement, Pre-Commit, Review, Commit, Create PR, Watch PR Status Checks, Investigate PR Status Checks, Mark PR Ready for Review, Decide PR Merge, or a terminal Complete, Failed, Needs Human, or Abandoned state. A successful step advances the Work Item; a failed step leaves the same action pending. A status watch batches unhandled green and red PR Status Checks into Investigate PR Status Checks, polls again after 30 seconds while checks remain pending, and advances to Mark PR Ready for Review once the aggregate is green and every observed terminal check is handled. After the PR is ready for review, Decide PR Merge asks the Implement OpenCode Session whether risk is low enough for a clanker to merge (Complete) or a human must merge (Needs Human); the step does not merge.
_Avoid_: Last completed step, phase

**PR Status Check**:
An individual GitHub check run or commit status context associated with a pull request. An execution is green on explicit success and red on explicit failure, error, timeout, action-required, or startup-failure; neutral, skipped, cancelled, stale, and pending results do not trigger a handoff.
_Avoid_: Aggregate status-check rollup, workflow run

**Status Check Handoff**:
A durable batch of previously unhandled green and red PR Status Checks given to the Work Item's Implement Session by Investigate PR Status Checks. The prompt names red checks to diagnose and fix; when any check is green, it also asks OpenCode to inspect the latest pull-request review comments, disregard reviews that are visibly still in progress, and address worthwhile completed feedback.
_Avoid_: Check classification, one prompt per check

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

**Needs Human Work Item**:
A terminal Work Item that cannot continue autonomously: either a Status Check Handoff cannot be processed autonomously or requires a human decision, or Decide PR Merge judged the PR too risky for a clanker to merge. The Work Item records OpenCode's concise intervention reason.
_Avoid_: Failed Work Item, Failed Step Run

**Complete Work Item**:
A terminal Work Item for which implementation, pull-request creation, status checking, all observed Status Check Handoffs, Mark PR Ready for Review, and Decide PR Merge executed successfully, with GitHub reporting no failing or pending status checks, the PR marked ready for review, and OpenCode assessing merge risk as low enough for a clanker. Complete does not mean GitHub closed the Issue or the PR was merged.
_Avoid_: Approved, merged, done Issue

**Relevant Issue**:
A Ready-labeled Issue in a Supported Issue Hierarchy that remains pertinent to the harness: either an open root Issue, or a direct child whose parent is open and Ready-labeled. A closed root Issue, or a child with a closed or non-Ready-labeled parent, is not relevant.
_Avoid_: Active Issue (a Relevant Issue may be closed), Actionable Issue (actionability also depends on workflow constraints), Visible Issue (presentation-specific)
