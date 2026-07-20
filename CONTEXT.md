# Ready for Agent

Opinionated agentic software engineering harness that works GitHub issues into PRs for configured repositories.

## Language

**Repository**:
A GitHub repository the harness is configured to work on, identified by owner and name (case-insensitive identity; display casing preserved). One row per GitHub repo; the harness keeps a single local clone of it (bare or working). Displayed as `owner/name` — no separate display label.
_Avoid_: Repo (in formal docs), target, project, checkout

**End-to-End Fixture Repository**:
A dedicated Repository whose stable GitHub state is controlled as a fixture for end-to-end validation. It contains a permanent open, Ready-labeled sentinel Issue with fixed identity and content, no hierarchy or blockers, and no Issue-closing PR; scenarios need not reject unrelated Issues.
_Avoid_: Test repo, sandbox Repository, mutable fixture

**Paused**:
A Repository state in which the harness does not autonomously select work for the Repository while keeping its configuration. Keeping the Issue store current through scheduled polling continues while Paused. Explicit operator requests, including a manual Refresh Job or Implement Now and its resulting lifecycle, remain allowed; new Repositories start paused until deliberately unpaused. Not the same as a paused Work Item (see Pause Work Item).
_Avoid_: Disabled, inactive, enabled=false, Pause Work Item

**Repository settings**:
Per-Repository operator preferences: Paused, optional build model and variant (null falls back to harness defaults; if those are also unset the empty option is labeled as harness default not configured), optional review model and variant (null falls back to harness review settings, then the resolved build model/variant), and Auto-merge. Changing settings does not rewrite existing Work Items; build and review model/variant are captured when a Work Item is created. A repository build override alone is enough to create Work Items even when harness defaults are still unset.
_Avoid_: Project config, repo config file

**Harness Config**:
Harness-wide operator preferences stored as a single config row: optional default build model and build thinking level (variant), optional review model and review thinking level (null means same as build), and concurrency limits (default two OpenCode sessions and five concurrent Work Items). On a fresh empty database the build model and variant start null (unconfigured); there is no product-seeded free model. First-run UI opens Settings and shows a banner until a build model and thinking level are saved. Creating a Work Item fails with a structured error when neither a repository override nor harness defaults resolve a build model and variant.
_Avoid_: Default model seed, product default model

**Auto-merge**:
A Repository setting that, when enabled, lets Decide PR Merge ask whether a clanker may merge a low-risk PR; when disabled, Decide PR Merge always requires a human. Enabling Auto-merge does not itself merge pull requests; only a subsequent Merge PR step merges when Decide PR Merge chooses clanker merge. It applies only when a Work Item has a pull request and does not gate Close Issue for a No-Change Outcome.
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

**Issue Polling**:
The autonomous recurring initiation of Issue reconciliation for every credentialed Repository, including Paused Repositories. Adding a Repository's matching GitHub credential through the Harness activates polling; removing it suspends polling. Polling is serial: only one scheduled or manual Refresh Job executes at a time. A Repository's next scheduled attempt becomes eligible 120 to 150 seconds after its previous scheduled attempt finishes, whether that attempt succeeded or failed. Manual Refresh Jobs take precedence over scheduled attempts but neither interrupt a running attempt nor alter the Repository's polling cadence.
_Avoid_: Issue synchronization (suggests bidirectional updates), refresh interval (ambiguous about eligibility and execution)

**Polling Auto-heal Job**:
A durable high-priority startup request that makes the active Issue Polling set exactly match the Harness's credentialed Repositories, adding missing polling schedules and removing schedules for deleted or uncredentialed Repositories. Startup resets all exhausted polling-lane jobs before accepting new claims. The Auto-heal Job retries with backoff until reconciliation succeeds without delaying Harness startup.
_Avoid_: Issue reconciliation (changes the Issue store), startup migration (runs on every startup and may depend on external credentials)

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

**Issue-closing PR**:
A GitHub pull request that GitHub associates with an Issue through closing semantics, such as a supported closing keyword. A mere mention or other cross-reference does not make a pull request an Issue-closing PR.
_Avoid_: Related PR, linked PR (both can include incidental references)

**Work Item PR**:
A GitHub pull request whose exact identity is recorded by a Work Item. A matching Issue number or Git branch alone does not establish that the PR belongs to the Work Item. The PR need not use Issue-closing semantics. Complete, Failed, Needs Human, and Abandoned Work Items retain their Work Item PR; Reset relinquishes ownership by deleting the Work Item. When an Issue has multiple Issue-closing PRs, one matching Work Item PR is sufficient to establish that the harness is managing the Issue.
_Avoid_: Our PR, harness PR, associated PR

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
A durable record of one operator-requested attempt to complete a Leaf Issue's objective through the work lifecycle, using the OpenCode build model/variant and review model/variant captured at creation. The build model is used for Implement and related steps; the review model is used only for the Review step (and falls back to the build model when unset). It references the current Issue by Repository and GitHub issue number, captures the Issue title for identification after the Issue leaves the Issue store, records the exact identity of its pull request when one is created, and records the completion summary for a No-Change Outcome. Other Issue contents remain live rather than snapshotted. A Leaf Issue may produce multiple Work Items over time, but at most one may be unfinished at a time.
_Avoid_: Issue lifecycle, implementation job, attempt

**Implement**:
The Lifecycle Step that asks OpenCode to complete the Issue's objective. Completion may change repository files, produce findings, create or update GitHub artifacts, or perform other work required by the Issue; repository changes are not required.
_Avoid_: Edit code, generate code

**No-Change Outcome**:
A successful Work Item outcome that leaves no repository changes to commit because the Issue's objective was completed without changing repository files, such as by reporting findings or creating other Issues. Documentation, configuration, and other non-code repository changes are not a No-Change Outcome and follow the normal changed-work lifecycle.
_Avoid_: No-code outcome, empty change, no-op

**Assess Changes**:
The Lifecycle Step after Implement that determines whether the Work Item produced repository changes before repository quality gates run. Observable repository changes advance directly to Pre-Commit without consulting OpenCode. When the worktree appears unchanged, Assess Changes asks the Work Item's Implement Session to confirm that the absence of changes is intentional and provide a concise completion summary. A confirmed No-Change Outcome skips Pre-Commit and Review and follows the lifecycle's no-change branch. Assess Changes does not review the work.
_Avoid_: Review changes, empty-commit check

**Close Issue**:
The Lifecycle Step that publishes the No-Change Outcome's completion summary on the Work Item's GitHub Issue and closes that Issue after Assess Changes. It precedes local cleanup so the remote completion outcome is preserved even when cleanup must be retried.
_Avoid_: Complete Work Item, local cleanup

**Worker Slot**:
One unit of harness capacity reserved by an Admitted Work Item. Only Admitted Work Items occupy a Worker Slot; Work Items waiting for a Worker Slot do not. The number of occupied Worker Slots is bounded by a harness-wide maximum concurrent Work Items Config setting (default five, positive integer), re-read on each admission decision. Raising the bound admits waiters immediately up to the new limit; lowering it does not demote already-Admitted Work Items, but blocks new admissions until occupancy is at or below the new bound. Distinct from the OpenCode session limit and from job-worker fiber budget.
_Avoid_: OpenCode session limit, fiber budget, queue concurrency, concurrent Step Runs

**Admitted Work Item**:
An unfinished Work Item that has been granted a Worker Slot and may run Lifecycle Steps. A Work Item becomes Admitted when created while a Worker Slot is free, or when it is the next waiter and a slot frees, or when Retry or Start successfully re-acquires a free slot. A Worker Slot is released when the Work Item becomes terminal (Complete, Failed, Abandoned), Needs Human, paused (after any running Step Run finishes), or when a Step Run fails non-terminally (operator may Retry). A failed non-terminal Work Item does not auto-enter the wait queue; only Retry (or Start after Pause) attempts re-admission. Start or Retry when no slot is free leaves the Work Item Waiting for Worker Slot until re-admitted FIFO.
_Avoid_: Running Work Item (admission is not the same as a running Step Run), active Work Item

**Waiting for Worker Slot**:
The state of an unfinished, non-paused Work Item that has not yet been Admitted because all Worker Slots are occupied. It does not occupy a Worker Slot and has no Step Run and no lifecycle job until admission. Operators may create more Work Items than the Worker Slot bound with no separate cap on how many may wait; those extras remain Waiting for Worker Slot until admitted **FIFO by time entered this state** (creation time if never admitted; re-queue time after Start when no slot was free). No priority by Repository, Issue age, or operator. Operator-visible status is Waiting for worker slot with a message that a worker slot must become available; the current Lifecycle Step is unchanged and is not queued until admission.
_Avoid_: Queued Step Run, paused, Not Implemented

**Implement Now**:
An explicit operator request that creates a Work Item for a Leaf Issue. Work Items are not created automatically by Issue reconciliation or eligibility discovery. Creation is allowed when all Worker Slots are occupied; the new Work Item is then Waiting for Worker Slot rather than rejected. Creation is hard-blocked when no build model and variant can be resolved from repository override or harness defaults (`Select a default build model first`).
_Avoid_: Auto-implement, enqueue Issue

**Implement Locally**:
An explicit operator request that creates a Work Item for a Leaf Issue like Implement Now, but records that the Work Item should pause before remote completion. Subject to the same Worker Slot admission rules as Implement Now. Local steps run only after admission; changed work continues from Assess Changes through Pre-Commit and Review before pausing at Commit, while a No-Change Outcome pauses at Close Issue immediately after Assess Changes. No Step Run is enqueued for the paused step, so the operator can inspect the worktree. Start resumes the selected branch and continues the lifecycle.
_Avoid_: Local-only mode, dry run, Implement Now without PR

**Not Implemented**:
The derived status of an Issue for which no Work Item has ever been created. It is not a persisted Work Item lifecycle state.
_Avoid_: Pending, queued

**Implementable Issue**:
A current, open Leaf Issue with no listed blockers. A Work Item revalidates this predicate before every lifecycle advancement and fails terminally if the predicate no longer holds.
_Avoid_: Ready-labeled Issue, Relevant Issue, Leaf Issue

**Actionable Issue**:
An Implementable Issue with no unfinished Work Item, including no Needs Human Work Item or retryable persisted status-check failure for that Issue. Only an Actionable Issue may receive Implement Now or Implement Locally; Repository pause does not affect actionability.
_Avoid_: Not Implemented Issue, Ready-labeled Issue

**Lifecycle Step**:
The next action required for a Work Item: Create Worktree, Install Dependencies, Implement, Assess Changes, Pre-Commit, Review, Commit, Create PR, Watch PR Status Checks, Resolve PR Merge Conflict, Investigate PR Status Checks, Mark PR Ready for Review, Decide PR Merge, Merge PR, Close Issue, local cleanup, or a terminal Complete, Failed, Needs Human, or Abandoned state. A successful step advances the Work Item; a failed step leaves the same action pending. Create Worktree records the exact starting commit OID; Assess Changes compares the worktree and branch to that OID, sends observable repository changes (staged, unstaged, untracked, or commits after the starting OID) to Pre-Commit without continuing the OpenCode Session, and sends a confirmed No-Change Outcome to Close Issue, then local cleanup and Complete. A status watch prioritizes a known merge conflict over completed checks, otherwise batches unhandled green and red PR Status Checks into Investigate PR Status Checks, polls again after 30 seconds while mergeability or checks remain pending, and advances to Mark PR Ready for Review only after two consecutive green polls (30 seconds apart) with every observed terminal check handled; a merely behind branch does not trigger conflict resolution. When the rollup is `no_checks` and the current PR head commit was pushed at least two minutes before the poll, the watch advances immediately without the normal 60-second no-check grace or second confirmation poll (a harness-restart shortcut for already-stale heads; missing or invalid head push times keep the conservative path). After the PR is ready for review, Decide PR Merge asks whether a clanker may merge or a human must (Auto-merge disabled always requires a human); clanker merge advances to Merge PR (squash via GitHub), then local cleanup, then Complete; human handoff is Needs Human without merging, until a Refresh Job sees the Work Item PR merged (local cleanup then Complete) or closed unmerged (Abandon after local cleanup).
_Avoid_: Last completed step, phase

**Merge Revalidation Outcome**:
A handled Merge PR attempt in which GitHub does not merge because the pull request or its base changed after approval. The first three outcomes return the Work Item to Watch PR Status Checks; a fourth requires a human, while operational or API failures remain failed Merge PR Step Runs eligible for Retry.
_Avoid_: Merge failure, automatic Retry

**PR Status Check**:
An individual GitHub check run or commit status context associated with a pull request. An execution is green on explicit success and red on explicit failure, error, timeout, action-required, or startup-failure; neutral, skipped, cancelled, stale, and pending results do not trigger a handoff.
_Avoid_: Aggregate status-check rollup, workflow run

**Status Check Handoff**:
A durable batch of previously unhandled green and red PR Status Checks given to the Work Item's Implement Session by Investigate PR Status Checks. The prompt names each red check by display name and external id (and source when known), includes harness-loaded log diagnostics when available, and instructs Actions-job log fallback when Checks is forbidden; when any check is green, it also asks OpenCode to inspect the latest relevant automated-review comment and linked latest run attempt. Only a relevant review run or a comment from a recognized automated reviewer establishes that an automated review exists; ordinary CI, repository configuration, or generic bot activity does not. Finding no relevant automated-review run or comment is a normal no-op, without requiring proof that review automation is unconfigured. A genuinely active review is left alone and produces `WAITING`, which leaves the checks unhandled and returns to Watch after the normal poll delay unless the same handoff produced a replacement execution. A commit, push, or restart takes precedence as `PROCESSED`, handles the old batch, and lets replacement executions trigger reassessment. A terminal review is incomplete when it produced no relevant review comment or its latest relevant comment remains visibly partial; either condition requires a full workflow rerun even when GitHub reports success. Stale incomplete comments superseded by a completed attempt and arbitrary checkboxes in unrelated comments do not trigger reruns. Completed worthwhile feedback is addressed normally. OpenCode should restart transient infrastructure failures when appropriate. If processing the handoff produces a commit, OpenCode pushes it and comments on the existing pull request with the commit, verification, feedback addressed, and feedback declined with reasons. A structured `PROCESSED` verdict means OpenCode took an action expected to produce new check executions, including a replacement execution from rerunning an incomplete reviewer, or a green-only handoff had no relevant automated review or a genuinely completed review needed no change. A technical inability to inspect a positively identified review is `FAILED`, leaves the checks unhandled, and remains retryable; it is not a human decision. A terminal incomplete review is not eligible for the no-action exception; inability to restart it autonomously is `NEEDS_HUMAN` only when an operator must perform or decide the required action. A first `FAILED: <reason>` verdict triggers one focused recovery attempt and a second verdict; if that also reports `FAILED`, Investigate stops as a retryable failed Step Run with reason code `pr_status_checks_unresolved`, leaves the checks unhandled, and tells the operator to fix or rerun them on GitHub before choosing Retry checks. After `PROCESSED`, two consecutive failed aggregate polls with no new unhandled execution stop Watch with the same retryable reason instead of polling forever. Genuine human decisions still use `NEEDS_HUMAN`.
_Avoid_: Check classification, one prompt per check

**Merge Conflict Handoff**:
A highest-priority request given to the Work Item's Implement Session by Resolve PR Merge Conflict when its pull request conflicts with its current base branch. It asks only for rebasing the branch; completed PR Status Checks not previously handed off are retired because the rebase restarts them. A merely behind branch does not trigger this handoff.
_Avoid_: PR Status Check, conflict status check

**Step Run**:
A durable record of one scheduled execution attempt for a Work Item's Lifecycle Step, created when that attempt is queued and recording when it starts, finishes, and succeeds, fails, is interrupted, or is cancelled before starting. Retried steps produce additional Step Runs rather than replacing earlier attempts, allowing queue wait and execution duration to be measured separately.
_Avoid_: Step duration, job attempt

**Retry**:
An explicit operator request to create a new Step Run for a Work Item whose previous run failed. Lifecycle failures are not retried automatically. A failed Step Run has already released the Worker Slot; Retry must re-acquire a Worker Slot, and if none is free the Work Item becomes Waiting for Worker Slot with no Step Run until re-admission. A Needs Human outcome from Investigate PR Status Checks is also retryable: Retry clears the handoff reason, reopens the exact Status Check Handoff consumed by that attempt, and runs Investigate again in the existing Implement Session. Persisted terminal Failed records with failure code `pr_status_checks_unresolved` from older harness behavior remain retryable by restoring Watch PR Status Checks. Retry is not allowed while a Work Item is paused; the operator must Start first.
_Avoid_: Queue redelivery, resume

**Pause Work Item**:
An explicit operator request that marks an unfinished Work Item paused so it will not start further Lifecycle Steps until Start. A running Step Run is not interrupted; after it finishes, the next step is neither enqueued nor started while paused. Step Runs still queued (not running) are cancelled. If the Work Item was Admitted and no Step Run is running, Pause releases its Worker Slot immediately; if a Step Run is still running, the Worker Slot is held until that Step Run finishes, then released. Pause is idempotent when already paused and is rejected for missing or terminal Work Items. A paused Work Item remains unfinished and still blocks Implement Now for that Issue. Distinct from Repository Paused.
_Avoid_: Suspend, hold, Abandon, Repository Paused

**Start Work Item**:
An explicit operator request that clears a Work Item's paused flag and attempts to re-acquire a Worker Slot. If a Step Run is still running (Pause has not yet released the slot), only the paused flag is cleared so normal advancement resumes when that Step Run finishes. If no Step Run is running and a Worker Slot is free, the Work Item is re-Admitted and a new Step Run for the current Lifecycle Step is enqueued once when the latest run does not require Retry. If no Worker Slot is free and no Step Run is running, the Work Item becomes Waiting for Worker Slot and no Step Run is enqueued until re-admission. Start is idempotent when not paused and is rejected for missing or terminal Work Items.
_Avoid_: Resume, unpause, Retry

**Abandon**:
A transition that moves a Work Item with no running Step Run to the terminal Abandoned state while preserving its history. From an operational Lifecycle Step it does not remove the worktree and releases any Worker Slot; from Needs Human it must re-acquire a Worker Slot, run local cleanup, and only Abandons if cleanup succeeds—if no slot is free, the Work Item becomes Waiting for Worker Slot until admitted for that cleanup. It may be operator-directed (including from Needs Human) or applied automatically when a Refresh Job finds that a merge-related Needs Human Work Item's Work Item PR was closed unmerged. Repository removal may apply it to non-running Work Items before deleting that Repository's lifecycle history. An Abandoned Work Item no longer prevents a later Implement Now request for the same Issue. Pause does not block Abandon. Abandon of a Work Item that is only Waiting for Worker Slot (never admitted, or waiting after Start) is immediate with no cleanup and no slot involved.
_Avoid_: Delete, cancel

**Reset**:
An operator-directed erasure of a Work Item that stops queued or running Step Runs, removes the Git worktree and branch, and deletes the Work Item and its Step Run history so the Issue returns to Not Implemented. Unlike Abandon, Reset does not preserve history. Reset is allowed while paused or Waiting for Worker Slot and removes the Work Item entirely, releasing a Worker Slot if one was held (including when a Step Run is still finishing after Pause).
_Avoid_: Abandon, Retry, cancel

**Failed Work Item**:
A terminal Work Item that cannot advance because a lifecycle precondition, such as the referenced Issue still existing and remaining Relevant, was not met. Its Step Run retains the outcome of the Effect itself, and the Work Item records the separate failure reason. Unresolved status checks stop on a retryable failed Step Run rather than producing a Failed Work Item.
_Avoid_: Failed Step Run, Abandoned

**Needs Human Work Item**:
A Work Item that cannot continue autonomously: either a Status Check Handoff cannot be processed autonomously or requires a human decision, Decide PR Merge requires a human (including when Auto-merge is disabled), or Merge PR cannot proceed after its revalidation budget is exhausted or GitHub rejects an unchanged mergeable PR. It records a concise intervention reason. Entering Needs Human releases its Worker Slot. It is terminal for ordinary Lifecycle Step advancement, Pause, and Start, and it blocks a second Implement Now or Implement Locally for the same Issue. A Needs Human outcome from Investigate PR Status Checks may be retried after intervention; other Needs Human outcomes are not eligible for Retry. A Refresh Job may still leave Needs Human when the latest step was Decide PR Merge or Merge PR: a merged Work Item PR advances to local cleanup toward Complete; a closed unmerged Work Item PR Abandons after local cleanup succeeds. Those Refresh-driven resumptions must re-acquire a Worker Slot; if none is free, the Work Item becomes Waiting for Worker Slot until admitted. Other Needs Human causes are not auto-resumed by Refresh.
_Avoid_: Failed Work Item, Failed Step Run

**Complete Work Item**:
A terminal Work Item whose remote outcome is finished and whose local cleanup has finished. For changed work, the Work Item PR is merged, either by the harness after a clanker Decide PR Merge decision or by a human before a Refresh Job resumes cleanup. For a No-Change Outcome, the GitHub Issue is closed without a pull request.
_Avoid_: Approved, done Issue

**Relevant Issue**:
A Ready-labeled Issue in a Supported Issue Hierarchy that remains pertinent to the harness. It must be either an open root Issue, or a direct child whose parent is open and Ready-labeled. It must also have no open or merged Issue-closing PR, or have at least one open or merged Issue-closing PR whose exact identity matches a Work Item PR recorded for that Issue. Closed unmerged (abandoned) Issue-closing PRs are ignored for this test. An Issue-closing PR affects only its own Issue rather than the Issue's parent or children. A closed root Issue, a child with a closed or non-Ready-labeled parent, or an Issue with only unowned open or merged Issue-closing PRs is not relevant.
_Avoid_: Active Issue (a Relevant Issue may be closed), Actionable Issue (actionability also depends on workflow constraints), Visible Issue (presentation-specific)
