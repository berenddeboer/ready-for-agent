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
Per-Repository operator preferences: Paused, optional build Agent Model selection, optional review Agent Model selection, Auto-merge, and Include all Issue Authors. An absent build model inherits the whole Harness build selection; an absent review model inherits the Harness review selection and then the resolved build selection; an explicit model with no Thinking Level uses that model's backend default. Build and review selections are resolved at each Agent Turn from current Repository settings falling back to Harness Config, so a settings change affects the next turn of an existing Work Item without rewriting it; changing Agent Backend clears every Repository's model selections.
_Avoid_: Project config, repo config file

**Harness Config**:
Harness-wide operator preferences stored as a single config row: the Agent Backend selected for the next Harness startup (OpenCode by default), optional default build Agent Model and Thinking Level, optional review Agent Model and Thinking Level (no review model means the build selection), and concurrency limits (default two concurrent Agent Turns and five concurrent Work Items). An Agent Backend change takes effect after restart, is rejected while any Work Item is unfinished, and clears every Harness and Repository Agent Model selection because model identities are backend-local. On a fresh empty database the build model starts null (unconfigured); there is no product-seeded free model. First-run UI opens Settings and shows a banner until a build model is saved. Creating a Work Item fails with a structured error when neither a Repository override nor Harness Config resolves a build Agent Model.
_Avoid_: Default model seed, product default model

**Auto-merge**:
A Repository setting that, when enabled, lets Decide PR Merge ask whether a clanker may merge a low-risk PR; when disabled, Decide PR Merge always requires a human. Enabling Auto-merge does not itself merge pull requests; only a subsequent Merge PR step merges when Decide PR Merge chooses clanker merge. It applies only when a Work Item has a pull request and does not gate Close Issue for a No-Change Outcome.
_Avoid_: Automerge (GitHub product), auto-approve

**Include all Issue Authors**:
A boolean Repository setting (default false for new and existing Repositories) that opts into treating Ready-labeled Issues from every author as candidates for relevance. When false, the Issue Reconciler keeps only Issues whose Issue Author matches the Operator GitHub User (case-insensitive); missing or ghost authors never match. When true, author does not filter relevance.
_Avoid_: Show all authors, mine only toggle (as a separate UI control)

**Issue Author**:
The GitHub login of the user who opened an Issue, when GitHub provides one; otherwise null. Fetched with Ready-labeled Issues, stored on the local Issue record, and used for author-scoped relevance when Include all Issue Authors is off.
_Avoid_: Assignee, reporter (unless matching GitHub’s author field)

**Operator GitHub User**:
The GitHub login of the authenticated principal for a Repository’s GitHub credential path (Keymaxxer-injected token or ambient `gh` auth). Resolved via the GitHub API viewer for that token during reconciliation when Include all Issue Authors is off; not a separate harness user account.
_Avoid_: Harness user, local operator account

**Issue**:
A GitHub issue belonging to a Repository, identified within that Repository by a positive integer GitHub issue number and represented locally with its title, body, web URL, creation time, GitHub state, and optional Issue Author. The harness may retain a local representation for later use, but GitHub remains authoritative.
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
The long-lived loopback companion process that owns one Keymaxxer stdio keyholder and exposes the Keymaxxer MCP tools over Streamable HTTP so the Harness and Keymaxxer-capable Agent Backends can share one vault session and Allow-session set without ambient secret values.
_Avoid_: Credential daemon, token cache, development-only sidecar

**Agent Backend**:
A supported headless coding-agent CLI integration shipped with Ready for Agent that can execute Agent Turns for the Harness. Repositories and Work Items do not select an Agent Backend; arbitrary external backend plugins are not part of this boundary.
_Avoid_: Agent (ambiguous), model, provider

**Active Agent Backend**:
The one Agent Backend loaded by a running Harness to execute Agent Turns. Each Work Item captures it as provenance, and Harness Config cannot select a different backend while any Work Item is unfinished.
_Avoid_: Repository backend, Work Item backend selection

**Grok Build**:
The supported xAI coding Agent Backend selected in Harness Config with the stable ID `grok`. Distinct from a Grok Agent Model.
_Avoid_: Grok (when referring to the backend), grok-build (as the config ID)

**Agent Backend Unavailable**:
A degraded Harness state established only by failed startup inspection or Recheck Agent Backend when the Active Agent Backend cannot execute Agent Turns or report its Agent Models. The UI, non-agent maintenance, and Agent-free Lifecycle Steps remain available, but new Agent Turns and Work Item creation are blocked until a Recheck succeeds; runtime Agent Turn failures instead fail only their Step Run, and the Harness never silently falls back to another backend.
_Avoid_: Startup failure, automatic fallback, Paused Repository

**Agent Backend Restart Required**:
A degraded Harness state after Harness Config selects an Agent Backend different from the Active Agent Backend. The UI, non-agent maintenance, and Agent-free Lifecycle Steps remain available, but new Agent Turns and Work Item creation are blocked until restart activates the selection.
_Avoid_: Hot backend switch, Agent Backend Unavailable

**Recheck Agent Backend**:
An explicit operator request that revalidates the Active Agent Backend and refreshes its Agent Model catalog. Success clears Agent Backend Unavailable and permits Agent Turns to resume; failure leaves the Harness degraded with an actionable reason.
_Avoid_: Automatic health poll, model-cache refresh only, Harness restart

**Agent Model**:
A model in the Active Agent Backend's instance-wide catalog for Agent Turns. Its identity and availability are backend-specific rather than Repository-specific; each Agent Turn resolves build and review Agent Models from current Repository settings falling back to Harness Config rather than from Work Item state.
_Avoid_: Provider, Agent Backend, model profile

**Thinking Level**:
An optional, backend-defined effort setting for an Agent Model. An Agent Model may offer no Thinking Levels; `variant` is OpenCode's representation rather than the Harness term.
_Avoid_: Variant, required reasoning effort

**Session**:
An Agent Backend-owned conversation identified to the Harness by its backend provenance and an opaque backend-local Session ID, scoped to a working directory, and continued across one or more Agent Turns and Harness restarts. Its identity is made durable while the first turn is still running; the Harness does not persist or reconstruct conversation history, and each turn may select a different Agent Model and Thinking Level without starting a new Session.
_Avoid_: chat, thread, conversation (in formal docs)

**Session Telemetry**:
Optional Agent Backend-provided details about a Session, such as models, token totals, cost, and timestamps. An Agent Backend may support Agent Turns without exposing Session Telemetry; unsupported telemetry is distinct from a missing Session.
_Avoid_: Agent Turn Result, required backend capability

**Agent Turn**:
One fully unattended headless Agent Backend CLI invocation within a Session using an explicit Agent Model and optional Thinking Level. An Agent Backend must support both the first turn and later turns that continue the same Session; file, shell, and tool permissions cannot wait for operator approval during the turn.
_Avoid_: Agent run, prompt run, OpenCode process

**Agent Turn Result**:
The normalized successful output of an Agent Turn: its Session ID and ordered final assistant text, recovered from the Agent Backend's machine-readable output. Backend-specific events and terminal presentation are not part of the result.
_Avoid_: CLI stdout, transcript, tool-event stream

**Agent-free Lifecycle Step**:
A Lifecycle Step guaranteed not to invoke an Agent Turn. A step that may need an Agent Turn conditionally is not Agent-free and does not start while the Agent Backend is Unavailable or an Agent Backend Restart is Required.
_Avoid_: Step that usually avoids the agent, non-OpenCode step

**Agent Command**:
A slash command invoked verbatim by a Lifecycle Step and expected to have common semantics across Agent Backends. `/review` is the only required Agent Command; its availability is not checked by Recheck Agent Backend, so a missing command fails the Review Step Run when invoked.
_Avoid_: Backend-specific prompt template, readiness capability

**Agent GitHub Access**:
Authentication available to GitHub commands invoked during Agent Turns. A backend may integrate the Keymaxxer named-secret tools, but need not; otherwise it uses authenticated ambient `gh` access, and the Harness never copies raw GitHub tokens into the Agent Turn environment.
_Avoid_: Required Keymaxxer support, injected GitHub token

**Ready-labeled Issue**:
An Issue carrying the `ready-for-agent` GitHub label, regardless of whether the Issue is open or closed. A fetched Ready-labeled Issue includes its number, title, body, web URL, creation time, GitHub state, and Issue Author (login when GitHub provides one) so consumers can decide whether it is actionable.
_Avoid_: Ready Issue (can imply that the Issue is open and actionable)

**Issue-closing PR**:
A GitHub pull request that GitHub associates with an Issue through closing semantics, such as a supported closing keyword. A mere mention or other cross-reference does not make a pull request an Issue-closing PR.
_Avoid_: Related PR, linked PR (both can include incidental references)

**Work Item PR**:
A GitHub pull request whose exact identity is recorded by a Work Item. A matching Issue number or Git branch alone does not establish that the PR belongs to the Work Item. The PR need not use Issue-closing semantics. Complete, Failed, Needs Human, and Abandoned Work Items retain their Work Item PR; Reset relinquishes ownership by deleting the Work Item. When an Issue has multiple Issue-closing PRs, one matching Work Item PR is sufficient to establish that the harness is managing the Issue.
_Avoid_: Our PR, harness PR, associated PR

**Last PR Change**:
The later of a Work Item PR's creation and the push of its current head commit, both of which are Check-Start Anchors. When GitHub omits the current head's push time, the time that head is first observed is the conservative substitute.
_Avoid_: Last commit time (ambiguous with author or commit timestamps), Watch start time

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
A durable record of one operator-requested attempt to complete a Leaf Issue's objective through the work lifecycle, capturing the active Agent Backend as provenance. Build and review Agent Model selections are not stored on the Work Item; each Agent Turn resolves them from current Repository settings falling back to Harness Config. The resolved build selection is used for Implement, Review Fix Rounds, Commit, and related steps; the resolved review selection is used only for reviewing passes inside Review. It references the current Issue by Repository and GitHub issue number, captures the Issue title for identification after the Issue leaves the Issue store, records the exact identity of its pull request when one is created, and records the completion summary for a No-Change Outcome. Other Issue contents remain live rather than snapshotted. A Leaf Issue may produce multiple Work Items over time, but at most one may be unfinished at a time.
_Avoid_: Issue lifecycle, implementation job, attempt

**Implement**:
The Lifecycle Step that starts or continues the Work Item's Session with an Agent Turn to complete the Issue's objective. Completion may change repository files, produce findings, create or update GitHub artifacts, or perform other work required by the Issue; repository changes are not required.
_Avoid_: Edit code, generate code

**No-Change Outcome**:
A successful Work Item outcome that leaves no repository changes to commit because the Issue's objective was completed without changing repository files, such as by reporting findings or creating other Issues. Documentation, configuration, and other non-code repository changes are not a No-Change Outcome and follow the normal changed-work lifecycle.
_Avoid_: No-code outcome, empty change, no-op

**Assess Changes**:
The Lifecycle Step after Implement that determines whether the Work Item produced repository changes before repository quality gates run. Observable repository changes advance directly to Pre-Commit without an Agent Turn. When the worktree appears unchanged, Assess Changes asks the Work Item's Session to confirm that the absence of changes is intentional and provide a concise completion summary. A confirmed No-Change Outcome skips Pre-Commit and Review and follows the lifecycle's no-change branch. Assess Changes does not review the work.
_Avoid_: Review changes, empty-commit check

**Pre-Commit**:
The Lifecycle Step that runs the repository's git pre-commit hook on staged Work Item changes before Review, with an Agent Turn fix loop on hook failure. It may also run again inside Review after a Review Fix Round changes the worktree.
_Avoid_: Pre-push, CI gate, local lint only

**Review**:
The Lifecycle Step after Pre-Commit that critiques the Work Item's repository changes with the review model, then may apply accepted Review Findings with the build model in bounded Review Fix Rounds before Commit. Operator-visible phases stay under this one step: reviewing, applying findings, pre-commit, and assessing rerun inside the loop.
_Avoid_: Code review PR check, Mark PR Ready for Review, advisory-only review

**Review Finding**:
A standards or specification issue reported by Review against the Work Item's changes. A build-model Agent Turn may fix or clear low- or medium-severity findings and may defer them; a high-severity finding must be fixed and re-reviewed or handed to a human.
_Avoid_: Lint error, CI failure, comment thread

**Review Severity**:
The highest impact assigned to any Review Finding in one reviewing pass: low has no plausible runtime or contract impact, medium has bounded behavior or correctness impact, and high has security, data-loss, major-contract, or broad/systemic impact. A clean reviewing pass has no Review Severity; medium and high require another reviewing pass after fixes, while low is eligible for a Review Rerun Assessment.
_Avoid_: Finding list, risk score, priority

**Unresolved Review Severity**:
The highest Review Severity still unresolved after a build-model pass interprets the findings. A deferred result records this aggregate as low or medium; an unresolved high-severity finding requires human attention.
_Avoid_: Original severity, finding count, per-finding status

**Review Rerun Assessment**:
A narrow build-model Agent Turn after applied low-severity Review Findings and nested Pre-Commit that uses the shared Session's account of those changes to decide, with a short rationale, whether they require another reviewing pass. It may skip only direct, localized, semantics-preserving remediation; expanded scope, higher-risk change categories, or uncertainty require a rerun.
_Avoid_: Re-review, self-review, diff check

**Accepted Review Outcome**:
A successful Review outcome in which a Review Rerun Assessment determines, with a recorded rationale, that applied findings do not require another reviewing pass. It advances to Commit without claiming that the changed remediation was reviewed clean and preserves any lower-severity findings deferred during the same remediation.
_Avoid_: Clean review, skipped review, deferred finding

**Cleared Review Outcome**:
A successful Review outcome in which the build model rejects all low- or medium-severity Review Findings as invalid without changing the worktree. It advances to Commit with a recorded rationale; high-severity findings cannot be cleared this way.
_Avoid_: Clean review, deferred finding, fixed finding

**Review Fix Round**:
One build-model pass that interprets Review Findings and changes the worktree, possibly while deferring other findings, followed by Pre-Commit and either a Review Rerun Assessment or a mandatory reviewing pass. A Review Step Run allows at most five rounds; exhausting the limit without a clean, deferred, or Accepted Review Outcome is Needs Human.
_Avoid_: Implement redo, unbounded fix loop

**Commit**:
The Lifecycle Step after successful Review that creates the local git commit for the Work Item's changes. It stages and commits only; it does not implement Review Findings or other rework.
_Avoid_: Create PR, git commit hook, Pre-Commit

**Close Issue**:
The Lifecycle Step that publishes the No-Change Outcome's completion summary on the Work Item's GitHub Issue and closes that Issue after Assess Changes. It precedes local cleanup so the remote completion outcome is preserved even when cleanup must be retried.
_Avoid_: Complete Work Item, local cleanup

**Worker Slot**:
One unit of harness capacity reserved by an Admitted Work Item. Only Admitted Work Items occupy a Worker Slot; Work Items waiting for a Worker Slot do not. The number of occupied Worker Slots is bounded by a harness-wide maximum concurrent Work Items Config setting (default five, positive integer), re-read on each admission decision. Raising the bound admits waiters immediately up to the new limit; lowering it does not demote already-Admitted Work Items, but blocks new admissions until occupancy is at or below the new bound. Distinct from the concurrent Agent Turn limit and from job-worker fiber budget.
_Avoid_: OpenCode session limit, fiber budget, queue concurrency, concurrent Step Runs

**Admitted Work Item**:
An unfinished Work Item that has been granted a Worker Slot and may run Lifecycle Steps. A Work Item becomes Admitted when created while a Worker Slot is free, or when it is the next waiter and a slot frees, or when Retry or Start successfully re-acquires a free slot. A Worker Slot is released when the Work Item becomes terminal (Complete, Failed, Abandoned), Needs Human, paused (after any running Step Run finishes), or when a Step Run fails non-terminally (operator may Retry). A failed non-terminal Work Item does not auto-enter the wait queue; only Retry (or Start after Pause) attempts re-admission. Start or Retry when no slot is free leaves the Work Item Waiting for Worker Slot until re-admitted FIFO.
_Avoid_: Running Work Item (admission is not the same as a running Step Run), active Work Item

**Waiting for Worker Slot**:
The state of an unfinished, non-paused Work Item that has not yet been Admitted because all Worker Slots are occupied. It does not occupy a Worker Slot and has no Step Run and no lifecycle job until admission. Operators may create more Work Items than the Worker Slot bound with no separate cap on how many may wait; those extras remain Waiting for Worker Slot until admitted **FIFO by time entered this state** (creation time if never admitted; re-queue time after Start when no slot was free). No priority by Repository, Issue age, or operator. Operator-visible status is Waiting for worker slot with a message that a worker slot must become available; the current Lifecycle Step is unchanged and is not queued until admission.
_Avoid_: Queued Step Run, paused, Not Implemented

**Implement Now**:
An explicit operator request that creates a Work Item for a Leaf Issue. Work Items are not created automatically by Issue reconciliation or eligibility discovery. Creation is allowed when all Worker Slots are occupied; the new Work Item is then Waiting for Worker Slot rather than rejected. Creation is hard-blocked while the Agent Backend is Unavailable, an Agent Backend Restart is Required, or no build Agent Model can be resolved from Repository settings or Harness Config (`Select a default build model first`).
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
The next action required for a Work Item: Create Worktree, Install Dependencies, Implement, Assess Changes, Pre-Commit, Review, Commit, Create PR, Watch PR Status Checks, Resolve PR Merge Conflict, Investigate PR Status Checks, Mark PR Ready for Review, Decide PR Merge, Merge PR, Close Issue, local cleanup, or a terminal Complete, Failed, Needs Human, or Abandoned state. In the PR completion loop, Watch prioritizes merge conflicts and Status Check Handoffs, sends a settled draft through Mark PR Ready for Review, and sends a settled ready PR past its Check-Start Deadline to Decide PR Merge.
_Avoid_: Last completed step, phase

**Merge Revalidation Outcome**:
A handled Merge PR attempt in which GitHub does not merge because the pull request or its base changed after approval. The first three outcomes return the Work Item to Watch PR Status Checks; a fourth requires a human, while operational or API failures remain failed Merge PR Step Runs eligible for Retry.
_Avoid_: Merge failure, automatic Retry

**PR Status Check**:
An individual GitHub check run or commit status context associated with a pull request. An execution is green on explicit success and red on explicit failure, error, timeout, action-required, or startup-failure; neutral, skipped, cancelled, stale, and pending results do not trigger a handoff.
_Avoid_: Aggregate status-check rollup, workflow run

**Expected PR Status Check**:
A required status context for which GitHub has not reported an execution. It may block final advancement before the Check-Start Deadline, but it is not a started check and no longer blocks at or after the deadline.
_Avoid_: Pending PR Status Check, queued check, running check

**Check-Start Anchor**:
The latest known event expected to start PR Status Checks: the Last PR Change, marking the Work Item PR ready for review, or a successful request to rerun or restart checks. Each new anchor gives GitHub another catch-up window in which replacement checks may appear.
_Avoid_: Last PR Change (when a ready transition, rerun, or restart is newer), Watch start time

**Check-Start Deadline**:
The instant 90 seconds after the latest Check-Start Anchor, before which neither an absence of checks nor an all-terminal observed set proves startup is complete. At or after the deadline, the harness assumes every check has started, while checks already pending are still watched until they finish.
_Avoid_: No-check grace, Watch residence time, check completion timeout

**Automated Review Output**:
Feedback published by a recognized automated reviewer for a PR Status Check, treated as fully published once that check is terminal. No comment means no feedback, while present but visibly incomplete output indicates a failed review eligible for bounded whole-review reruns.
_Avoid_: Eventually consistent review comment, pending comment

**Status Check Handoff**:
A durable batch of previously unhandled green and red PR Status Checks given to the Work Item's Implement Session by Investigate PR Status Checks, including available red-check diagnostics and relevant Automated Review Output. It is handled as processed when no replacement is expected, as a Checks Triggered Outcome when an action should create new executions, or as an explicit failure or human handoff; terminal review output never creates a waiting outcome.
_Avoid_: Check classification, one prompt per check

**Checks Triggered Outcome**:
A Status Check Handoff outcome reporting that a completed action, such as a commit push or successful check restart, is expected to create new PR Status Check executions. It handles the old batch and creates a Check-Start Anchor, unlike a processed handoff that expects no replacement execution.
_Avoid_: Waiting, processed no-op, observed replacement check

**Merge Conflict Handoff**:
A highest-priority request given to the Work Item's Implement Session by Resolve PR Merge Conflict when its pull request conflicts with its current base branch. It asks only for rebasing the branch; completed PR Status Checks not previously handed off are retired because the rebase restarts them. A merely behind branch does not trigger this handoff.
_Avoid_: PR Status Check, conflict status check

**Step Run**:
A durable record of one scheduled execution attempt for a Work Item's Lifecycle Step, created when that attempt is queued and recording when it starts, finishes, and succeeds, fails, is interrupted, or is cancelled before starting. Retried steps produce additional Step Runs rather than replacing earlier attempts, allowing queue wait and execution duration to be measured separately.
_Avoid_: Step duration, job attempt

**Retry**:
An explicit operator request to create a new Step Run for a Work Item whose previous run failed. Lifecycle failures are not retried automatically. A failed Step Run has already released the Worker Slot; Retry must re-acquire a Worker Slot, and if none is free the Work Item becomes Waiting for Worker Slot with no Step Run until re-admission. A Needs Human outcome from Investigate PR Status Checks is also retryable: Retry clears the handoff reason, reopens the exact Status Check Handoff consumed by that attempt, and runs Investigate again in the existing Implement Session. A Needs Human outcome from exhausting Review Fix Rounds is also retryable: Retry clears the reason, resets the round counter, and re-enters Review at a fresh reviewing pass in the existing Implement Session. Persisted terminal Failed records with failure code `pr_status_checks_unresolved` from older harness behavior remain retryable by restoring Watch PR Status Checks. Retry is not allowed while a Work Item is paused; the operator must Start first.
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
A Work Item that cannot continue autonomously: either a Status Check Handoff cannot be processed autonomously or requires a human decision, Decide PR Merge requires a human (including when Auto-merge is disabled), Merge PR cannot proceed after its revalidation budget is exhausted or GitHub rejects an unchanged mergeable PR, or Review exhausts its Review Fix Round limit without a clean or deferred outcome. It records a concise intervention reason. Entering Needs Human releases its Worker Slot. It is terminal for ordinary Lifecycle Step advancement, Pause, and Start, and it blocks a second Implement Now or Implement Locally for the same Issue. A Needs Human outcome from Investigate PR Status Checks or from exhausting Review Fix Rounds may be retried after intervention; other Needs Human outcomes are not eligible for Retry. A Refresh Job may still leave Needs Human when the latest step was Decide PR Merge or Merge PR: a merged Work Item PR advances to local cleanup toward Complete; a closed unmerged Work Item PR Abandons after local cleanup succeeds. Those Refresh-driven resumptions must re-acquire a Worker Slot; if none is free, the Work Item becomes Waiting for Worker Slot until admitted. Other Needs Human causes are not auto-resumed by Refresh.
_Avoid_: Failed Work Item, Failed Step Run

**Complete Work Item**:
A terminal Work Item whose remote outcome is finished and whose local cleanup has finished. For changed work, the Work Item PR is merged, either by the harness after a clanker Decide PR Merge decision or by a human before a Refresh Job resumes cleanup. For a No-Change Outcome, the GitHub Issue is closed without a pull request.
_Avoid_: Approved, done Issue

**Relevant Issue**:
A Ready-labeled Issue in a Supported Issue Hierarchy that remains pertinent to the harness. It must be either an open root Issue, or a direct child whose parent is open and Ready-labeled. It must also have no open or merged Issue-closing PR, or have at least one open or merged Issue-closing PR whose exact identity matches a Work Item PR recorded for that Issue. Closed unmerged (abandoned) Issue-closing PRs are ignored for this test. An Issue-closing PR affects only its own Issue rather than the Issue's parent or children. Unless Include all Issue Authors is on for the Repository, the Issue’s own Issue Author must match the Operator GitHub User (case-insensitive); missing or ghost authors never match, and parent authorship does not include or exclude children. A closed root Issue, a child with a closed or non-Ready-labeled parent, or an Issue with only unowned open or merged Issue-closing PRs is not relevant.
_Avoid_: Active Issue (a Relevant Issue may be closed), Actionable Issue (actionability also depends on workflow constraints), Visible Issue (presentation-specific)
