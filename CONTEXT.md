# Ready for Agent

Opinionated agentic software engineering harness that works Forge issues into pull requests for configured Repositories.

## Language

**Forge**:
A code-hosting platform kind the harness supports as a Repository's source of git hosting, Issues, and Pull Requests: GitHub, GitLab, or Azure DevOps. A Repository belongs to exactly one Forge, chosen when the Repository is added. Azure DevOps now has the same end-to-end lifecycle as GitHub and GitLab: remote detection, PAT-based authentication, Ready Issue listing/reconciliation (including native Predecessor/Successor blocking links, surfaced as blockedBy), draft Pull Request creation, PR Status Checks (build validation / branch policy evaluations), merge, and work item close-out with a completion summary are all implemented.
_Avoid_: Provider (overloaded with model provider and credential metadata), issue source (too narrow — the Forge also hosts Pull Requests and checks), platform

**Forge Host**:
The hostname of the Forge instance serving a Repository — `github.com` for GitHub, or a self-managed GitLab instance such as `git.drupalcode.org`. It is part of Repository identity: the same Project Path on two different Forge Hosts denotes two different Repositories. The git remote's hostname is not authoritative for the Forge Host — an instance may serve SSH on a different hostname (git.drupal.org vs git.drupalcode.org).
_Avoid_: Instance URL, server, domain

**Project Path**:
The Forge's own slash-separated path addressing the project within its Forge Host — `owner/name` for GitHub, a group or nested subgroup path for GitLab (e.g., `project/oauth_client`), and `<organization>/<project>` for Azure DevOps, with an optional third segment (`<organization>/<project>/<repository>`) when the Git repository's name differs from its project's. Case-insensitive identity; display casing preserved.
_Avoid_: Owner/repo pair (cannot express nested GitLab paths), clone URL (too many spellings for one project)

**Repository**:
A project on a Forge the harness is configured to work on, identified by Forge, Forge Host, and Project Path (case-insensitive identity; display casing preserved). One row per configured Repository identity; the harness keeps a single local clone of it (bare or working). Displayed as its Project Path — no separate display label. Forge, Forge Host, and Project Path are guessed from the local clone's remote when the Repository is added, verified against the Forge API, and may be corrected in Repository settings; changing them is rejected while any Work Item exists for the Repository.
_Avoid_: Repo (in formal docs), target, project, checkout

**End-to-End Fixture Repository**:
A dedicated Repository whose stable Forge state is controlled as a fixture for end-to-end validation. It contains a permanent open, Ready-labeled sentinel Issue with fixed identity and content, no hierarchy or blockers, and no Issue-closing PR; scenarios need not reject unrelated Issues.
_Avoid_: Test repo, sandbox Repository, mutable fixture

**Paused**:
A Repository state in which the harness does not autonomously select work for the Repository while keeping its configuration. Keeping the Issue store current through scheduled polling continues while Paused. Explicit operator requests, including a manual Refresh Job or Implement Now and its resulting lifecycle, remain allowed; new Repositories start paused until deliberately unpaused. Not the same as a paused Work Item (see Pause Work Item).
_Avoid_: Disabled, inactive, enabled=false, Pause Work Item

**Repository settings**:
Per-Repository operator preferences: Paused, optional Agent Backend override, optional build Agent Model selection, optional review Agent Model selection, Merge Policy, Include all Issue Authors, and Wait for checks to start after ready for review (`waitForReadyForReviewChecks`, default true). Forge identity (Forge, Forge Host, and Project Path) is also corrected through Repository settings, subject to the Work Item gate described under Repository. An absent Agent Backend override inherits the Harness Config default Agent Backend. Build and review model selections are backend-scoped: each Agent Backend has its own optional overrides. An absent build model inherits the whole Harness build selection for the Repository's effective Agent Backend; an absent review model inherits the Harness review selection for that backend and then the resolved build selection; an explicit model with no Thinking Level uses that model's backend default. For a Work Item without an Explicit Work Item Execution Profile, build and review selections are resolved at each Agent Turn from current backend-scoped Repository settings falling back to backend-scoped Harness Config for the Work Item's captured Agent Backend, so a model settings change affects the next turn without rewriting the Work Item. Changing the Agent Backend override is rejected while the Repository has an unfinished Work Item whose routing depends on that effective backend; an unfinished Work Item with an Explicit Work Item Execution Profile does not block the change.
_Avoid_: Project config, repo config file

**Harness Config**:
Harness-wide operator preferences stored as a single config row: the default Agent Backend (OpenCode by default), backend-scoped optional default build Agent Model and Thinking Level, backend-scoped optional review Agent Model and Thinking Level (no review model means the build selection), and concurrency limits (default two concurrent Agent Turns and five concurrent Work Items). The default Agent Backend applies to Repositories without an override. Changing the default is rejected while an unfinished Work Item on an inheriting Repository depends on that effective backend; an unfinished Work Item with an Explicit Work Item Execution Profile does not block the change. When allowed, the change hot-activates on Save (no Harness restart), remembers each backend's model selections separately, and may leave that backend's build model null (unconfigured) like first-run. On a fresh empty database the build model starts null; there is no product-seeded free model. First-run UI opens Settings and shows a banner until the default backend has a build model; Repositories with a fully configured override are not blocked by an unconfigured default. Ordinary Work Item creation fails with a structured error when the Repository's effective Agent Backend is Unavailable or no build Agent Model can be resolved for that backend from Repository settings or Harness Config (`Select a default build model first`).
_Avoid_: Default model seed, product default model

**Merge Policy**:
The three-state merge setting (`off` / `classify` / `always`) offered by Repository settings and Implement With. `off` requires a human merge; `classify` runs Decide PR Merge's existing risk assessment; `always` skips Classify only and, after the Check-Start Deadline, treats `no_checks` as green. Pending, failed, and Expected checks, merge conflicts, and Forge refusal still block Always. New Repositories default to `off`. Distinct from Auto-merge, which is only the parent Always command.
_Avoid_: Repository Auto-merge, Automerge (GitHub product), yolo (not a stored value, GraphQL enum member, or UI label)

**Work Item Merge Policy**:
A nullable durable pin of Merge Policy on a Work Item. `null` inherits the live Repository Merge Policy at merge-routing time; a concrete pin (`off` / `classify` / `always`) is the effective policy regardless of later Repository flips. Implement With always writes a pin when options are present; Implement Now, Queue, and Repository Intake leave it unset; Implement All with Auto-merge pins `always`. Retry and Start keep the pin.
_Avoid_: Work Item Auto-merge override, per-Issue Auto-merge, publication policy (as an execution-profile field)

**Auto-merge**:
The parent-only Always command: Implement All with Auto-merge. It means Always — it pins Work Item Merge Policy `always` on created and adopted children — and is not a Repository setting or an Implement With choice.
_Avoid_: Automerge (GitHub product), auto-approve

**Merge Mode**:
Derived Work Item view of whether the Work Item Merge Policy pin is Always. `always` means the pin is `always` and skips Decide PR Merge; `ordinary` means the pin is unset, `off`, or `classify`. After the Check-Start Deadline, `no_checks` is green for Always and not for Classify. Pending, failed, and Expected checks, merge conflicts, merge revalidation of non-green aggregates other than Always+`no_checks`, and Forge refusal still block Always. Stored on the Work Item as the Always-pin encoding and survives restarts. A merge-related Needs Human handoff reached before the pin became `always` is not revoked.
_Avoid_: Auto-merge (parent Always command), force merge, skip checks

**Include all Issue Authors**:
A boolean Repository setting (default false for new and existing Repositories) that opts into treating Ready-labeled Issues from every author as candidates for relevance. When false, the Issue Reconciler keeps only Issues whose Issue Author matches the Operator Forge User (case-insensitive); missing or ghost authors never match. When true, author does not filter relevance.
_Avoid_: Show all authors, mine only toggle (as a separate UI control)

**Issue Author**:
The Forge username of the user who opened an Issue, when the Forge provides one (the GitHub login or GitLab username); otherwise null. Fetched with Ready-labeled Issues, stored on the local Issue record, and used for author-scoped relevance when Include all Issue Authors is off.
_Avoid_: Assignee, reporter (unless matching the Forge’s author field)

**Operator Forge User**:
The Forge username of the authenticated principal for a Repository’s Forge credential path (Keymaxxer-injected token or ambient Forge CLI auth). Resolved via the Forge API viewer endpoint for that token during reconciliation when Include all Issue Authors is off; not a separate harness user account.
_Avoid_: Harness user, local operator account

**Harness GitHub Operation**:
One replay-safe Harness-native action that may make one or more sequential GitHub GraphQL or REST requests while holding one GitHub Operation Coordinator permit. A successful local cache hit is not a Harness GitHub Operation because it creates no GitHub traffic; each operation must be idempotent or revalidate its remote postcondition before a mutation can be replayed.
_Avoid_: GitHub request, GitHub task

**GitHub Operation Coordinator**:
The process-local Harness module that admits exactly one Harness GitHub Operation at a time for one application runtime. Callers choose only Operator, Lifecycle, Polling, or Background origin; normal admission is in that order with FIFO within an origin, and the globally oldest request is admitted after 60 seconds. The permit remains held through the entire active operation and is never preempted. This is not a host-wide queue or a proactive rate limiter: Agent Turns, other Harness runtimes, operator shells, Git transport, and GitHub Actions remain best-effort exclusions.
_Avoid_: Global GitHub queue, rate limiter

**GitHub Throttled**:
A process-local flow-control condition established only by explicit GitHub throttle evidence. It closes GitHub Operation Coordinator admission until `retryAt`, immediately returns that deadline to pending and new Harness GitHub Operations, and clears when the deadline elapses. It reacts to GitHub’s stated limit; it does not reserve quota or perform proactive quota budgeting.
_Avoid_: Rate limited, quota budget

**Issue**:
An issue on the Repository's Forge, identified within that Repository by a positive integer issue number (the iid in GitLab) and represented locally with its title, body, web URL, creation time, Forge state, and optional Issue Author. The harness may retain a local representation for later use, but the Forge remains authoritative. GitLab issues and merge requests come from separate per-project number sequences, so a bare GitLab number is ambiguous across the two kinds — unlike GitHub's single shared sequence.
_Avoid_: Ticket, task (unless referring to a broader concept)

**Issue store**:
The harness capability that retains the Repository's current working set of Relevant Issue representations locally. It does not fetch, refresh, or establish the authoritative state of Issues.

**Issue Reconciler**:
The sole harness capability that changes the Issue store, deriving one Repository's Relevant Issues from the Forge's authoritative set of Ready-labeled Issues. Issues that are not Relevant, including Issues whose ready label was removed, are absent from the Issue store after reconciliation.
_Avoid_: GitHub Reconciler (too broad), Issue Synchronizer (suggests bidirectional updates)

**Refresh Job**:
A durable request for the Issue Reconciler to reconcile one Repository. Acceptance of a Refresh Job does not mean reconciliation has completed. After reconciliation succeeds, competing active Issue-closing PRs stop eligible unfinished Work Items to Needs Human; then unfinished Work Items that own a Work Item PR are inspected for merge outcomes and, for certain Needs Human handoffs, mergeability: a merged PR advances local cleanup toward Complete (including Work Items paused because the Issue closed while the PR was open); closed-unmerged Abandon applies when the latest step was Decide PR Merge, Merge PR, or Resolve PR Merge Conflict; Decide/Merge Needs Human with a conflicting open PR advances to Resolve PR Merge Conflict; Resolve Needs Human whose open PR is no longer conflicting advances to Watch PR Status Checks. Refresh does not auto-Start a Work Item paused for a closed Issue with an open PR.
_Avoid_: Refresh (ambiguous between the request and its execution), sync job

**Issue Polling**:
The autonomous recurring initiation of Issue reconciliation for every credentialed Repository, including Paused Repositories. Adding a Repository's matching Forge credential through the Harness activates polling; removing it suspends polling. Polling is serial: only one scheduled or manual Refresh Job executes at a time. A Repository's next scheduled attempt becomes eligible 60 to 90 seconds after its previous scheduled attempt finishes, whether that attempt succeeded or failed. Manual Refresh Jobs take precedence over scheduled attempts but neither interrupt a running attempt nor alter the Repository's polling cadence.
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
A supported coding-agent integration shipped with Ready for Agent that can execute Agent Turns for the Harness. Harness Config, Repository settings, and an Explicit Work Item Execution Profile may select among built-in backends; arbitrary external backend plugins are not part of this boundary.
_Avoid_: Agent (ambiguous), model, provider, ACP (the protocol is not a backend)

**Effective Agent Backend**:
The Agent Backend a Repository uses for ordinary new Work Items: the Repository override when set, otherwise the Harness Config default. Ordinary creation requests capture it; Implement With may explicitly choose another backend for that Work Item without changing Repository settings or Harness Config.
_Avoid_: Active Agent Backend (the runtime set), preferred backend without capture

**Active Agent Backend**:
An Agent Backend the running Harness has hot-activated and may use for Agent Turns and model catalogs. Zero or more backends may be Active concurrently. A backend is kept Active while it is selected-or-in-use: the harness default, any Repository override, or the captured backend of any unfinished Work Item. Leaving that set drops it from Active. Each Work Item routes Agent Turns to its captured backend, which must be Active and not Unavailable for those turns.
_Avoid_: Single instance-wide backend only, Selected vs Active limbo, dual backends on one Work Item mid-ship

**Grok Build**:
The supported xAI coding Agent Backend with the stable ID `grok`. Distinct from a Grok Agent Model.
_Avoid_: Grok (when referring to the backend), grok-build (as the config ID)

**Codex Build**:
The supported OpenAI coding Agent Backend with the stable ID `codex`. Distinct from a Codex Agent Model.
_Avoid_: Codex (when referring to the backend), codex-build (as the config ID)

**Claude Code**:
The supported Anthropic coding Agent Backend with the stable ID `claude`. Distinct from a Claude Agent Model.
_Avoid_: Claude (when referring to the backend), claude-code (as the config ID)

**Agent Backend Unavailable**:
A per-backend degraded state established by failed startup inspection, failed hot-activation on Save, or Recheck Agent Backend when that Agent Backend cannot execute Agent Turns or report its Agent Models. The UI, non-agent maintenance, and Agent-free Lifecycle Steps remain available. New Agent Turns and Work Item creation that need the Unavailable backend are blocked until a Recheck (or successful re-activation) for that backend succeeds; other backends are unaffected. Runtime Agent Turn failures fail only their Step Run, and the Harness never silently falls back to another backend. Unavailable does not block changing selections while the applicable idle gate allows.
_Avoid_: Startup failure, automatic fallback, harness-wide block when another backend is healthy, Paused Repository, restart required

**Agent Backend Preview**:
An inspection of a not-yet-saved Agent Backend selection that loads that backend's Agent Model catalog for Settings or Implement With. It does not add or change an Active Agent Backend or allow Agent Turns on the previewed backend.
_Avoid_: Hot activate, Recheck Agent Backend

**Recheck Agent Backend**:
An explicit operator request that revalidates one Agent Backend by id and refreshes its Agent Model catalog. Success clears that backend's Agent Backend Unavailable and permits Agent Turns on it to resume; failure leaves that backend degraded with an actionable reason. Optional UI may recheck every selected-or-in-use backend.
_Avoid_: Automatic health poll, model-cache refresh only, Harness restart, Agent Backend Preview

**Agent Model**:
A model in an Agent Backend's catalog for Agent Turns. Its identity and availability are backend-specific rather than Repository-specific. Ordinary Work Items resolve build and review selections for each Agent Turn from current backend-scoped Repository settings falling back to Harness Config; an Explicit Work Item Execution Profile instead supplies durable selections for that Work Item. Selection is catalog-only: selection surfaces offer exactly the chosen Agent Backend's current catalog. Advertised Thinking Levels are part of each catalog entry's executable contract; an unsupported pair is rejected at Settings and before an Agent Turn rather than rewritten. A selected value the current catalog no longer lists is preserved and shown as unavailable rather than deleted, rewritten, translated between provider modes, or replaced by defaults; it blocks creation or a later Agent Turn before that turn starts. An Agent Backend that reports no catalog at all carries no membership information and does not block ordinary work, but Implement With requires a non-empty catalog from which to make its explicit choices.
_Avoid_: Provider, Agent Backend, model profile

**Thinking Level**:
An optional, backend-defined effort setting for an Agent Model. A non-null Thinking Level is valid only when the governing Agent Model's current catalog entry advertises it. An Agent Model may offer no Thinking Levels; null uses that model's backend default rather than substituting another scope's level. `variant` is OpenCode's representation rather than the Harness term.
_Avoid_: Variant, required reasoning effort

**Session**:
An Agent Backend-owned conversation identified to the Harness by its backend provenance and an opaque backend-local Session ID, scoped to a working directory, and continued across one or more Agent Turns and Harness restarts. Its identity is made durable while the first turn is still running; the Harness does not persist or reconstruct conversation history, and each turn may select a different Agent Model and Thinking Level without starting a new Session.
_Avoid_: chat, thread, conversation (in formal docs)

**Session Telemetry**:
Optional Agent Backend-provided details about a Session, such as models, token totals, cost, and timestamps. An Agent Backend may support Agent Turns without exposing Session Telemetry; unsupported telemetry is distinct from a missing Session.
_Avoid_: Agent Turn Result, required backend capability

**Agent Turn**:
One fully unattended invocation of an Agent Backend within a Session using an explicit Agent Model and optional Thinking Level. An Agent Backend must support both the first turn and later turns that continue the same Session; file, shell, and tool permissions cannot wait for operator approval during the turn.
_Avoid_: Agent run, prompt run, OpenCode process, ACP request

**Agent Turn Tail**:
A bounded excerpt of recent activity in the latest Agent Turn of a Work Item's canonical Session: assistant text and tool names/status, without tool payloads or child Session activity. The Harness does not persist it.
_Avoid_: Session tail, transcript, conversation, Session Telemetry

**Interactive Session Continuation**:
An operator-driven interactive use of a Work Item's canonical Session through its captured Agent Backend and working directory. Its messages become part of the Session used by later Agent Turns, but the continuation is not itself an Agent Turn or Lifecycle Step.
_Avoid_: Agent Turn, Resume Work Item, human-only fork

**Agent Turn Result**:
The normalized successful output of an Agent Turn: its Session ID and ordered final assistant text, recovered from the Agent Backend's machine-readable output. Backend-specific events and terminal presentation are not part of the result.
_Avoid_: CLI stdout, transcript, tool-event stream

**Agent-reported Outcome**:
A lifecycle-specific, machine-readable conclusion included in an Agent Turn's final assistant text so the Harness can choose the next lifecycle transition. It is semantic lifecycle data carried inside, but distinct from, the transport-level Agent Turn Result.
_Avoid_: Ruling, verdict, Agent Turn Result

**Agent-free Lifecycle Step**:
A Lifecycle Step guaranteed not to invoke an Agent Turn. A step that may need an Agent Turn conditionally is not Agent-free and does not start while the Work Item's captured Agent Backend is Unavailable.
_Avoid_: Step that usually avoids the agent, non-OpenCode step

**Agent Command**:
A slash command invoked verbatim by a Lifecycle Step and expected to have common semantics across Agent Backends. `/review` is the only required Agent Command; its availability is not checked by Recheck Agent Backend, so a missing command fails the Review Step Run when invoked.
_Avoid_: Backend-specific prompt template, readiness capability

**Agent Forge Access**:
Authentication available to Forge commands invoked during Agent Turns. A backend may integrate the Keymaxxer named-secret tools, but need not; otherwise it uses authenticated, host-scoped ambient Forge access (the `gh` CLI on GitHub; the `glab` CLI on GitLab), and the Harness never copies raw Forge tokens into the Agent Turn environment. On GitLab, a per-Repository vault secret (`provider: gitlab`, `account: <forge-host>/<project-path>`) is strictly more specific than ambient sources when Keymaxxer is enabled; Agent Turns prefer `keymaxxer_run` with that secret to invoke `glab`, mapping the named secret to `GITLAB_TOKEN` only inside the Keymaxxer child process, and fall back to host-authenticated ambient `glab` when none exists.
_Avoid_: Required Keymaxxer support, injected Forge token

**Ready-labeled Issue**:
An Issue carrying the `ready-for-agent` Forge label, regardless of whether the Issue is open or closed. A fetched Ready-labeled Issue includes its number, title, body, web URL, creation time, Forge state, and Issue Author (username when the Forge provides one) so consumers can decide whether it is actionable.
_Avoid_: Ready Issue (can imply that the Issue is open and actionable)

**Pull Request**:
A proposal to merge one branch into another on a Forge, reviewed and merged through the Forge: a GitHub pull request or a GitLab merge request.
_Avoid_: Merge request, MR (GitLab's name for the same concept)

**Issue-closing PR**:
A Pull Request that the Forge associates with an Issue through closing semantics, such as a supported closing keyword. A mere mention or other cross-reference does not make one an Issue-closing PR.
_Avoid_: Related PR, linked PR (both can include incidental references)

**Work Item PR**:
A Pull Request whose exact identity is recorded by a Work Item. Exact ownership is the persisted Forge repository or project together with the PR number. A matching Issue number or Git branch alone does not establish that the PR belongs to the Work Item. A remotely visible PR on a Work Item's deterministic Create PR branch with matching source repository or project identity is only a pending self-ownership race guard for that Refresh observation; it does not persist the Work Item PR number or authorize PR lifecycle steps. The PR need not use Issue-closing semantics. Complete, Failed, Needs Human, and Abandoned Work Items retain their Work Item PR; Reset relinquishes ownership by deleting the Work Item. When an Issue has multiple Issue-closing PRs, one matching Work Item PR is sufficient to establish that the harness is managing the Issue.
_Avoid_: Our PR, harness PR, associated PR

**Last PR Change**:
The later of a Work Item PR's creation and the push of its current head commit, both of which are Check-Start Anchors. When the Forge omits the current head's push time, the time that head is first observed is the conservative substitute.
_Avoid_: Last commit time (ambiguous with author or commit timestamps), Watch start time

**Supported Issue Hierarchy**:
A GitHub issue hierarchy wholly contained within one Repository and limited to a root Issue with optional direct children. A hierarchy containing a cross-Repository relationship or a grandchild is unsupported in its entirety. GitLab Issues do not participate in a hierarchy: every GitLab Issue is a root with no children and is therefore structurally a Standalone Issue.
_Avoid_: Issue tree (implies arbitrary depth), nested Issues

**Listed Blockers**:
The other Issues recorded as blocking an Issue. On GitHub they are the Issue's native blocked-by issue dependencies. On GitLab they are parsed from a `Blocked by: #n` line in the Issue body, since a GitLab instance cannot be assumed to offer native blocking links. An Issue with no Listed Blockers is unblocked.
_Avoid_: Dependencies (overloaded), linked issues (GitLab relates-to links are informational and do not block)

**Parent Issue**:
A root Issue with one or more direct children. It organizes related work and may receive Implement All with Auto-merge, but is not itself a unit the harness works directly.
_Avoid_: PRD (the relationship does not establish document type), epic

**Implement All with Auto-merge**:
An atomic explicit operator request on a Parent Issue covering the open Child Issues present when the request is accepted. Children added later are not part of that request. It creates a separate Work Item for each covered child without unfinished work and pins every covered unfinished Work Item's Work Item Merge Policy to `always`; if any child cannot be enrolled, none are created or changed. An unblocked child starts through the ordinary remote implementation and Worker Slot admission path, while a blocked child waits for its blockers through Queue. Siblings may run concurrently; hierarchy and child order add no dependency, and one child's later failure or Needs Human outcome does not stop its siblings. The Parent Issue itself does not become a Work Item, and the request never closes or updates it. The request does not overturn a Work Item already stopped at a merge-related Needs Human handoff.
_Avoid_: Queue Parent Issue, Parent Work Item, Implement Now with Auto-merge

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
A durable record of one operator-requested attempt to complete a Leaf Issue's objective through the work lifecycle, capturing an Agent Backend as provenance and routing authority, an optional Explicit Work Item Execution Profile, and an optional Work Item Merge Policy pin (`null` inherits the live Repository Merge Policy). Without an explicit profile, each Agent Turn resolves build and review selections from current backend-scoped Repository settings falling back to Harness Config. With one, the profile's build selection is used for Implement, Review Fix Rounds, Commit, and related steps, while its review selection is used only for reviewing passes inside Review. It references the current Issue by Repository and issue number, captures the Issue title for identification after the Issue leaves the Issue store, records canonical publication title and body after Commit generates them (agent-authored when valid, with in-directory image links rewritten to GitHub user-attachment URLs before persist, otherwise harness fallback copy from the Issue identity; shared by git commit and draft PR), records the exact identity of its pull request when one is created, and records the completion summary for a No-Change Outcome. Other Issue contents remain live rather than snapshotted. A Leaf Issue may produce multiple Work Items over time, but at most one may be unfinished at a time.
_Avoid_: Issue lifecycle, implementation job, attempt

**Explicit Work Item Execution Profile**:
A durable, immutable override of the Agent Backend, build Agent Model and optional Thinking Level, and review selection used by one Work Item for its entire lifetime. The review selection is either a distinct Agent Model and optional Thinking Level or the durable intent to use exactly the build selection. It does not carry a Work Item Merge Policy pin or pause-before-step behavior. Implement With always persists an explicit profile, even when the pre-filled choices are submitted unchanged, without changing Repository settings or Harness Config; ordinary creation has no explicit profile and keeps resolving models from current settings. Retry and Start retain the profile, missing catalog selections fail closed without substitution, and choosing another profile requires Reset followed by a new attempt.
_Avoid_: Issue settings, per-Issue settings, model snapshot

**Implement**:
The Lifecycle Step that starts or continues the Work Item's Session with an Agent Turn to complete the Issue's objective. Completion may change repository files, produce findings, create or update Forge artifacts, or perform other work required by the Issue; repository changes are not required.
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
The Lifecycle Step after Pre-Commit that critiques the Work Item's repository changes with the review model, then may apply accepted Review Findings with the build model in bounded Review Fix Rounds before Commit. A missing or malformed reviewing or apply-findings control marker gets one no-tools verdict-repair turn; an unparseable apply that changed the worktree is revalidated rather than treated as fixed, and an unparseable unchanged apply is Needs Human. Operator-visible phases stay under this one step: reviewing, applying findings, pre-commit, and assessing rerun inside the loop.
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
One build-model pass that interprets Review Findings and changes the worktree, possibly while deferring other findings, followed by Pre-Commit and either a Review Rerun Assessment or a mandatory reviewing pass. An apply-findings turn that changes the worktree but leaves an unparseable outcome after one verdict-repair turn also counts as a round and is revalidated the same way. A Review Step Run allows at most five rounds; exhausting the limit without a clean, deferred, or Accepted Review Outcome is Needs Human.
_Avoid_: Implement redo, unbounded fix loop

**Commit**:
The Lifecycle Step after successful Review that creates the local git commit for the Work Item's changes. Before the first native mutation it continues the Work Item Session for one publication-copy Agent Turn (unless canonical copy is already persisted or can be seeded from an existing commit) and one format-correction turn if needed; if both are malformed it persists harness fallback copy from the Issue identity rather than failing. After a valid agent copy is normalized and before it is persisted, local markdown image links that resolve inside the Work Item attachment directory are rewritten to GitHub user-attachment URLs; that post-rewrite body is the canonical publication copy. It then stages and commits with that copy; it does not implement Review Findings or other rework. The harness attempts a native git commit with the persisted copy and continues the Session only as a repair fallback when the native path does not establish the postcondition; repair may re-seed copy from the actual final commit message.
_Avoid_: Create PR, git commit hook, Pre-Commit

**Close Issue**:
The Lifecycle Step that publishes the No-Change Outcome's completion summary on the Work Item's Issue and closes that Issue after Assess Changes. It precedes local cleanup so the remote completion outcome is preserved even when cleanup must be retried.
_Avoid_: Complete Work Item, local cleanup

**Worker Slot**:
One unit of harness capacity reserved by an Admitted Work Item. Only Admitted Work Items occupy a Worker Slot; Work Items waiting for a Worker Slot do not. The number of occupied Worker Slots is bounded by a harness-wide maximum concurrent Work Items Config setting (default five, positive integer), re-read on each admission decision. Raising the bound admits waiters immediately up to the new limit; lowering it does not demote already-Admitted Work Items, but blocks new admissions until occupancy is at or below the new bound. Distinct from the concurrent Agent Turn limit and from job-worker fiber budget.
_Avoid_: OpenCode session limit, fiber budget, queue concurrency, concurrent Step Runs

**Admitted Work Item**:
An unfinished Work Item that has been granted a Worker Slot and may run Lifecycle Steps. A Work Item becomes Admitted when created while a Worker Slot is free and it is not Waiting for blockers, or when it leaves Waiting for blockers or is the next waiter and a slot frees, or when Retry or Start successfully re-acquires a free slot. A Worker Slot is released when the Work Item becomes terminal (Complete, Failed, Abandoned), Needs Human, paused (after any running Step Run finishes), after Interrupt Work Item finishes that Step Run, or when a Step Run fails non-terminally (operator may Retry). A failed non-terminal Work Item does not auto-enter the wait queue; only Retry (or Start after Pause) attempts re-admission. Start or Retry when no slot is free leaves the Work Item Waiting for Worker Slot until re-admitted FIFO.
_Avoid_: Running Work Item (admission is not the same as a running Step Run), active Work Item

**Waiting for blockers**:
The state of an unfinished Work Item created by Queue while its Issue still has listed blockers. It does not occupy a Worker Slot, has no Step Run and no lifecycle job, and cannot be force-started past blockers. When Issue reconciliation finds the Issue Implementable, the Work Item leaves this state and follows normal Worker Slot admission (FIFO with other waiters by time entered the admission wait; creation time if never admitted). If reconciliation finds the Issue no longer a valid open leaf candidate (closed, not Relevant, not a leaf, and so on), the Work Item fails terminally with that reason; remaining blocked while still a valid open leaf is not a failure. Operator-facing copy may read as queued waiting for the blocking Issues; the status is not the Step Run or Agent Turn **Queued** stamp.
_Avoid_: Queued (alone), Waiting for Worker Slot, blocked Issue (the Issue is blocked; this is the Work Item hold)

**Waiting for Worker Slot**:
The state of an unfinished, non-paused Work Item that is not Waiting for blockers and has not yet been Admitted because all Worker Slots are occupied. It does not occupy a Worker Slot and has no Step Run and no lifecycle job until admission. Operators may create more Work Items than the Worker Slot bound with no separate cap on how many may wait; those extras remain Waiting for Worker Slot until admitted **FIFO by time entered this state** (creation time if never admitted; re-queue time after Start when no slot was free; due-wake time when a GitHub wait cannot re-acquire a slot; the same creation time applies when a former Waiting for blockers Work Item joins this line). No priority by Repository, Issue age, or operator. Operator-visible status is Waiting for worker slot with a message that a worker slot must become available; the current Lifecycle Step is unchanged and is not queued until admission.
_Avoid_: Queued Step Run, paused, Not Implemented, Waiting for blockers

**Waiting for GitHub**:
A derived Work Item hold whose latest Step Run is a Postponed Step Run with a durable wake contract and retry deadline. It is not a Lifecycle Step, Work Item state, Queue hold, or Worker Slot wait: the Work Item remains in its current pipeline lane, holds no Worker Slot, and owns no queued or running Step Run. Any GitHub-dependent Lifecycle Step may create it; a due wake re-enters ordinary Worker Slot admission for that same Step and, if no slot is free, enters Waiting for Worker Slot at that wake time while retaining that FIFO position across duplicate delivery. It clears only when later lifecycle progress supersedes that Postponed history; Pause, Waiting for blockers, and Waiting for Worker Slot take presentation precedence.
_Avoid_: Queue, Waiting for Worker Slot, paused, Work Item state

**Implement Now**:
An explicit operator request that creates a Work Item for an Actionable Issue and seeks Worker Slot admission immediately. Work Items are not created automatically by Issue reconciliation or eligibility discovery. Creation is allowed when all Worker Slots are occupied; the new Work Item is then Waiting for Worker Slot rather than rejected. Creation is hard-blocked while the Repository's effective Agent Backend is Unavailable or no build Agent Model can be resolved for that backend from Repository settings or Harness Config (operator error names the Agent Backend, repository or harness scope, Settings / per-repository path, and available catalog models when known). It leaves Work Item Merge Policy unset so the Work Item inherits the live Repository Merge Policy. Distinct from Queue, which creates a Work Item only for a blocked open leaf and holds it until Implementable.
_Avoid_: Auto-implement, enqueue Issue, Queue

**Implement With**:
An explicit operator request for an Actionable Issue that chooses an Explicit Work Item Execution Profile plus a concrete Work Item Merge Policy pin and an optional Implement Locally inspection pause, then creates the Work Item through the same Worker Slot admission path as Implement Now. Its ephemeral `Implement issue #N with...` dialog is pre-filled from the Repository's effective backend, currently resolved model selections, and live Repository Merge Policy; model drafts stay backend-scoped while the Merge Policy control and Implement Locally checkbox stay dialog-wide; Implement Locally starts unchecked. A missing default build model leaves a required blank choice, and a failed backend selection does not disable choosing another backend. It requires a non-empty model catalog; submission atomically revalidates Issue eligibility, activates and inspects the chosen backend when necessary, validates catalog membership and the complete profile, persists the profile, Merge Policy pin, and pause target together, and creates nothing on failure. Callers that omit the options leave Work Item Merge Policy unset and keep the remote path. The dialog has Implement and Cancel actions and ordinary loading and failure feedback, but no recovery, recheck, fallback, or retry workflow. It is offered only as `Implement with...` directly below Implement now in the Issue actions menu and does not change Harness Config or Repository settings.
_Avoid_: Settings, Implement Locally With, per-Issue default

**Queue**:
An explicit operator request that creates a Work Item for a Relevant, open Leaf Issue that has listed blockers and no unfinished Work Item — the Issue would be Actionable except for blockers. The new Work Item is Waiting for blockers rather than Admitted. When the hold lifts, lifecycle and admission behave as if the operator had chosen Implement Now at that moment (full remote path, not Implement Locally), including when the Repository is Paused; backend or model problems after the hold lifts are handled like a post-create Implement Now failure, not by staying Waiting for blockers. Same hard blocks as Implement Now for the Repository's effective Agent Backend Unavailable and unresolved build Agent Model at request time. It leaves Work Item Merge Policy unset so the Work Item inherits the live Repository Merge Policy. Not offered on Actionable Issues or outside the Issue store.
_Avoid_: Implement Now, enqueue Issue, schedule, defer

**Repository Intake**:
An explicit operator request that considers every Relevant, open Leaf Issue in one Repository's current Issue projection, sends Implement Now for each Actionable Issue, and sends Queue for each blocked Issue eligible for Queue. Each Issue request is independent: a candidate-local failure does not roll back successful requests for other Issues or prevent later candidates from being attempted. Parent Issues and Issues with unfinished Work Items are left unchanged. Repository Intake neither refreshes Issues nor creates a durable aggregate or changes Harness or Repository settings. Created Work Items leave Work Item Merge Policy unset.
_Avoid_: Queue all, batch run, Parent Issue intake

**Intake Candidate**:
A Relevant, open Leaf Issue in one Repository's current Issue projection that would receive Implement Now or Queue if Repository Intake considered it now. The classification includes the intended request, so a caller does not need to interpret Issue hierarchy, blockers, or unfinished Work Items.
_Avoid_: Relevant Issue (broader), Intake Plan, Intake member

**Implement Locally**:
An explicit operator request that creates a Work Item for an Actionable Issue like Implement Now, but records that the Work Item should pause before remote completion. Subject to the same Worker Slot admission rules as Implement Now. Local steps run only after admission; changed work continues from Assess Changes through Pre-Commit and Review before pausing at Commit, while a No-Change Outcome pauses at Close Issue immediately after Assess Changes. No Step Run is enqueued for the paused step, so the operator can inspect the worktree. Start resumes the selected branch and continues the lifecycle. Implement With may request the same inspection pause while also persisting an Explicit Work Item Execution Profile and Work Item Merge Policy pin; the one-click Implement Locally action remains a separate command without those choices. Queue has no Locally variant.
_Avoid_: Local-only mode, dry run, Implement Now without PR, Queue

**Not Implemented**:
The derived status of an Issue for which no Work Item has ever been created. It is not a persisted Work Item lifecycle state.
_Avoid_: Pending, queued

**Implementable Issue**:
A current, open Leaf Issue with no listed blockers. A Work Item that is not Waiting for blockers revalidates this predicate before every lifecycle advancement. When the predicate no longer holds and no Work Item PR is owned, the Work Item fails terminally. When a Work Item PR is already recorded and the only revalidation failure is that the Issue is closed or missing, the Work Item does not fail: it branches on that PR's lifecycle (Pause with reason for open, closed-unmerged, or indeterminate; local cleanup toward Complete for merged). A Work Item Waiting for blockers instead remains held while blockers persist and only seeks admission once the predicate holds.
_Avoid_: Ready-labeled Issue, Relevant Issue, Leaf Issue

**Actionable Issue**:
An Implementable Issue with no unfinished Work Item, including no Needs Human Work Item or retryable persisted status-check failure for that Issue. Only an Actionable Issue may receive Implement Now or Implement Locally; Repository pause does not affect actionability. An open Leaf Issue that fails only the blockers part of Implementable may receive Queue when it has no unfinished Work Item.
_Avoid_: Not Implemented Issue, Ready-labeled Issue

**Lifecycle Step**:
The next action required for a Work Item: Create Worktree, Install Dependencies, Implement, Assess Changes, Pre-Commit, Review, Commit, Create PR, Watch PR Status Checks, Resolve PR Merge Conflict, Investigate PR Status Checks, Mark PR Ready for Review, Decide PR Merge, Merge PR, Close Issue, local cleanup, or a terminal Complete, Failed, Needs Human, or Abandoned state. Every operational Lifecycle Step declares whether it is Agent-free, its default maximum productive execution time, and whether a failed or interrupted Step Run permits Retry; in the PR completion loop, Watch prioritizes merge conflicts and red Status Check Handoffs (including while the Work Item PR is still draft), defers green-only Status Check Handoffs while any execution is still pending, then hands the accumulated unhandled batch once the aggregate settles, sends a green draft through Mark PR Ready for Review without waiting for the Check-Start Deadline, sends a check-less draft (`no_checks` or only Expected PR Status Checks) through Mark PR Ready for Review only at or after that deadline, and sends a settled ready PR past its Check-Start Deadline to Merge PR when the effective Merge Policy is Always, or to Decide PR Merge otherwise, except that Classify and `off` enter Needs Human when the aggregate is not a successful non-empty check set (Always treats post-deadline `no_checks` as green).
_Avoid_: Last completed step, phase

**Create Worktree**:
The Lifecycle Step that creates the Work Item's isolated Git worktree and records its starting commit.

**Install Dependencies**:
The Lifecycle Step that installs the Repository dependencies required to work on the Work Item.

**Create PR**:
The Lifecycle Step that pushes committed Work Item changes and creates their draft pull request.

**Watch PR Status Checks**:
The Lifecycle Step that observes the Work Item PR for merge conflicts, Status Check Handoffs, and settled completion conditions. A draft advances to Mark PR Ready for Review only on an all-green aggregate, or on `no_checks` or only Expected PR Status Checks at or after the Check-Start Deadline; red checks on a draft go to Investigate PR Status Checks while the PR stays draft. After the Check-Start Deadline, a ready PR whose effective Merge Policy is Always and whose aggregate is `no_checks` advances to Merge PR; Always still does not treat Expected PR Status Checks as green; Classify and `off` enter Needs Human for `no_checks` or only Expected PR Status Checks.

**Resolve PR Merge Conflict**:
The Lifecycle Step that asks the Work Item's Implement Session to rebase a conflicting pull-request branch.

**Investigate PR Status Checks**:
The Lifecycle Step that processes a durable Status Check Handoff in the Work Item's Implement Session.

**Mark PR Ready for Review**:
The Lifecycle Step that changes a Work Item PR from draft to ready for review after Watch observes all-green draft checks, or a check-less draft at or after the Check-Start Deadline. Red draft checks are investigated while the PR stays draft and do not reach this step.

**Decide PR Merge**:
The Lifecycle Step that decides whether a settled Work Item PR may be merged by the harness or requires a human.

**Merge PR**:
The Lifecycle Step that revalidates and merges an approved Work Item PR through its Forge.

**local cleanup**:
The Lifecycle Step that removes the Work Item's local worktree and branch after its remote outcome is finished.

**Complete**:
A terminal Work Item state whose remote outcome and local cleanup have both finished.

**Failed**:
A terminal Work Item state that cannot advance because a lifecycle precondition was not met.

**Needs Human**:
A Work Item state that cannot continue autonomously and records the intervention required from a human.

**Abandoned**:
A terminal Work Item state that preserves history after the attempt is stopped without completion.

**Merge Revalidation Outcome**:
A handled Merge PR attempt in which the Forge does not merge because the pull request or its base changed after approval. The first three outcomes return the Work Item to Watch PR Status Checks; a fourth requires a human, while operational or API failures remain failed Merge PR Step Runs eligible for Retry.
_Avoid_: Merge failure, automatic Retry

**PR Status Check**:
An individual GitHub check run or commit status context associated with a pull request; on GitLab, one job of the pull request's head pipeline. An execution is green on explicit success and red on explicit failure, error, timeout, action-required, or startup-failure; on GitLab a failed job that allows failure is not red. Neutral, skipped, cancelled, stale, and pending results do not trigger a handoff; nor do GitLab manual or canceled jobs.
_Avoid_: Aggregate status-check rollup, workflow run, pipeline (the container of jobs, not a check)

**Expected PR Status Check**:
A required status context for which GitHub has not reported an execution. It may block final advancement before the Check-Start Deadline, but it is not a started check. At or after the deadline it no longer waits for startup, and it does not satisfy the successful-check precondition for harness-initiated merge. GitLab has no required status contexts, so a GitLab pull request never has Expected PR Status Checks.
_Avoid_: Pending PR Status Check, queued check, running check

**Check-Start Anchor**:
The latest known event expected to start PR Status Checks: the Last PR Change, marking the Work Item PR ready for review, or a successful request to rerun or restart checks. Each new anchor gives the Forge another catch-up window in which replacement checks may appear.
_Avoid_: Last PR Change (when a ready transition, rerun, or restart is newer), Watch start time

**Check-Start Deadline**:
The instant 90 seconds after the latest Check-Start Anchor, before which neither an absence of checks nor an all-terminal observed set proves startup is complete. At or after the deadline, the harness assumes every check has started, while checks already pending are still watched until they finish. After the Check-Start Deadline, `no_checks` is green for Always and not for Classify; Expected PR Status Checks still do not authorize merge.
_Avoid_: No-check grace, Watch residence time, check completion timeout

**Ready-Phase Status Check Round**:
The fresh PR Status Check observation period after a pull request known to the harness as draft becomes ready for review. It protects repositories whose ready-for-review transition can start additional checks. Because Watch holds a draft until checks are green or until the Check-Start Deadline when none register (`no_checks` or only Expected PR Status Checks), the draft-phase evidence reaching this round is already all-green, post-deadline `no_checks`, or only Expected PR Status Checks; red draft checks are investigated while the PR stays draft and never supply this evidence. A Repository may omit this round when that green-gated or no-CI draft-phase evidence is sufficient, allowing Mark PR Ready for Review to advance directly to Merge PR when the effective Merge Policy is Always and those checks are successful or post-deadline `no_checks`, to Decide PR Merge when Classify or `off` checks are successful, or to Needs Human when Classify or `off` still has no successful checks. This omission does not shorten startup deadlines after PR creation, a head push, a check restart, or an automated-review rerun, and it never ignores an observed pending check or bypasses a known aggregate failure.
_Avoid_: Second CI run, duplicate checks, post-draft delay

**Automated Review Output**:
Feedback published by a recognized automated reviewer for a PR Status Check, treated as fully published once that check is terminal. No comment means no feedback. Present but visibly incomplete output (harness-classified from the latest correlated recognized-reviewer comment body: finished banner plus unchecked Aggregate-style substantive progress task and/or missing synthesis) is a failed review eligible for at most one harness-authorized whole-workflow recovery rerun on the same Work Item, PR head SHA, and workflow run; a repeated identical incomplete outcome enters Needs Human without another autonomous rerun or Investigate rediscovery loop. Agent-reported whole-review reruns remain bounded by the general three-rerun budget (ADR 0027). Needs Human reasons name the automated review workflow or check identity and must not read as blaming the Work Item implement Agent Model.
_Avoid_: Eventually consistent review comment, pending comment

**Status Check Handoff**:
A durable batch of previously unhandled green and red PR Status Checks given to the Work Item's Implement Session by Investigate PR Status Checks, including available red-check diagnostics and relevant Automated Review Output. Terminal green executions accumulate while the Forge still reports an actual pending execution; Watch hands them off only after the aggregate settles, so staggered greens produce one investigation. Unhandled red executions and merge conflicts still hand off immediately. It is handled as processed when no replacement is expected, as a Checks Triggered Outcome when an action should create new executions, or as an explicit failure or human handoff; terminal review output never creates a waiting outcome. For a settled green-only batch, harness-owned Forge observation may complete the handoff without an Investigate Agent Turn when there is demonstrably no positive automated-review evidence (`green-no-review-evidence`), or when Automated Review Output is harness-classified as visibly incomplete (at most one authorized whole-workflow recovery rerun on the same Work Item, PR head SHA, and workflow run; a repeated identical incomplete outcome enters Needs Human). Positive complete or ambiguous review evidence and every batch containing a red check still use the Investigate Agent Turn.
_Avoid_: Check classification, one prompt per check

**Checks Triggered Outcome**:
A Status Check Handoff outcome reporting that a completed action, such as a commit push or successful check restart, is expected to create new PR Status Check executions. It handles the old batch and creates a Check-Start Anchor, unlike a processed handoff that expects no replacement execution.
_Avoid_: Waiting, processed no-op, observed replacement check

**Merge Conflict Handoff**:
A highest-priority request given to the Work Item's Implement Session by Resolve PR Merge Conflict when its pull request conflicts with its current base branch. It asks only for rebasing the branch; completed PR Status Checks not previously handed off are retired because the rebase restarts them. A merely behind branch does not trigger this handoff.
_Avoid_: PR Status Check, conflict status check

**Step Run**:
A durable record of one scheduled execution attempt for a Work Item's Lifecycle Step, created when that attempt is queued and recording when it starts, finishes, and succeeds, fails, is interrupted, is postponed, or is cancelled before starting. Retried steps produce additional Step Runs rather than replacing earlier attempts, allowing queue wait and execution duration to be measured separately.
_Avoid_: Step duration, job attempt

**Postponed Step Run**:
A finished Step Run outcome that records `postponed` and one retry deadline (`postponedUntil`) because a GitHub-dependent Lifecycle Step must wait. It is immutable history, not a failed or successful attempt, and it cannot be retried manually; a later durable wake creates a fresh Step Run for the same Lifecycle Step through ordinary admission. A Postponed Step Run derives Waiting for GitHub without adding a Work Item lifecycle state or hold flag.
_Avoid_: Deferred Review Finding, Queued Step Run, Retry, Failed Step Run

**Retry**:
An explicit operator request to create a new Step Run for a Work Item whose previous run failed. Lifecycle failures are not retried automatically. A failed Step Run has already released the Worker Slot; Retry must re-acquire a Worker Slot, and if none is free the Work Item becomes Waiting for Worker Slot with no Step Run until re-admission. A Needs Human outcome from Investigate PR Status Checks is also retryable: Retry clears the handoff reason, reopens the exact Status Check Handoff consumed by that attempt, and runs Investigate again in the existing Implement Session. A Needs Human outcome from exhausting Review Fix Rounds or from an unparseable unchanged apply-findings verdict is also retryable: Retry clears the reason, resets the round counter, and re-enters Review at a fresh reviewing pass in the existing Implement Session. A Needs Human outcome from a missing successful status-check aggregate on an autonomous merge path is also retryable: Retry clears the handoff reason and returns to Watch PR Status Checks in the existing Implement Session, worktree, branch, and PR. Persisted terminal Failed records with failure code `pr_status_checks_unresolved` from older harness behavior remain retryable by restoring Watch PR Status Checks. A Step Run interrupted by Interrupt Work Item is retryable once that request has cleared Pause. Autonomous Retry does not accept a Step Run interrupted with reason paused. Retry is unavailable for a Postponed Step Run and while a Work Item is paused; the operator must Start first. Unattended `--all-retryable` Retry is an Autonomous Retry and is bounded by the Autonomous Retry Budget; explicit single-Issue, single-Work-Item, and UI Retry are not.
_Avoid_: Queue redelivery, resume

**Autonomous Retry**:
A Retry requested through unattended `--all-retryable` (or the equivalent Harness-owned bulk operation). Distinct from explicit single-Issue, single-Work-Item, and UI Retry.
_Avoid_: Automatic Retry, unattended Retry

**Autonomous Retry Budget**:
A durable, Harness-enforced limit on accepted Autonomous Retry execution attempts for one Work Item at its current Lifecycle Step. The default is 3. The initial Step Run is not an Autonomous Retry. The budget resets only after the Work Item successfully advances to another Lifecycle Step. Exhaustion reports LIMIT_REACHED without changing ordinary canRetry.
_Avoid_: max-attempts, client-side retry count

**Provider Hold**:
A future retry time extracted from a trustworthy machine-readable Agent Backend quota or rate-limit failure and persisted on the latest Step Run reason. While the hold is in the future, Autonomous Retry reports DEFERRED and consumes no Autonomous Retry Budget.
_Avoid_: guessed wake time, transcript-inferred retry

**Pause Work Item**:
An explicit operator request that marks an unfinished Work Item paused so it will not start further Lifecycle Steps until Start. A running Step Run is not interrupted; after it finishes, the next step is neither enqueued nor started while paused. A paused Work Item with a running Step Run may be stopped with Interrupt Work Item. Step Runs still queued (not running) are cancelled. If the Work Item was Admitted and no Step Run is running, Pause releases its Worker Slot immediately; if a Step Run is still running, the Worker Slot is held until that Step Run finishes, then released. Pause is idempotent when already paused and is rejected for missing, terminal, or Waiting for blockers Work Items (the hold already means do not run; cancel with Reset). A paused Work Item remains unfinished and still blocks Implement Now and Queue for that Issue. The harness also applies Pause Work Item when Issue revalidation finds the Issue closed or missing while the Work Item still owns a Work Item PR that is open, closed unmerged, or of indeterminate lifecycle status, recording an operator-visible reason for that branch—never an invisible non-terminal park with no pause flag and no reason. A confirmed merged PR advances to local cleanup instead of Pause. Start after reopening the Issue resumes the current Lifecycle Step; reopening alone does not auto-Start. A later Refresh Job that finds the Work Item PR merged still supersedes this pause and advances cleanup toward Complete. Closed-unmerged Abandon remains limited to Needs Human after Decide PR Merge, Merge PR, or Resolve PR Merge Conflict. Distinct from Repository Paused.
_Avoid_: Suspend, hold, Abandon, Repository Paused, Waiting for blockers, silent park, Interrupt Work Item

**Interrupt Work Item**:
An explicit operator request that stops a running Step Run on a paused Work Item without deleting the Work Item. It is legal only while the Work Item is paused and a Step Run is running. The Step Run is interrupted with reason paused; the paused flag is cleared; the worktree and Session are kept; the Worker Slot is released after that Step Run finishes. Resume is Retry, not Start. Distinct from Pause Work Item, which does not interrupt a running Step Run, and from Reset, which erases the Work Item.
_Avoid_: Pause Work Item, Reset, Stop, terminate, cancel, Start

**Start Work Item**:
An explicit operator request that clears a Work Item's paused flag and attempts to re-acquire a Worker Slot. If a Step Run is still running (Pause has not yet released the slot), only the paused flag is cleared so normal advancement resumes when that Step Run finishes. If no Step Run is running and a Worker Slot is free, the Work Item is re-Admitted and a new Step Run for the current Lifecycle Step is enqueued once when the latest run does not require Retry. If no Worker Slot is free and no Step Run is running, the Work Item becomes Waiting for Worker Slot and no Step Run is enqueued until re-admission. Start is idempotent when not paused except that a due Postponed Step Run receives ordinary Worker Slot admission: before its postponedUntil deadline Start may clear Pause but neither admits nor enqueues, and at or after that deadline it re-enters admission for the same Step. Start is rejected for missing, terminal, or Waiting for blockers Work Items (blockers cannot be bypassed; the hold lifts only when the Issue is Implementable).
_Avoid_: Resume, unpause, Retry

**Abandon**:
A transition that moves a Work Item with no running Step Run to the terminal Abandoned state while preserving its history. From an operational Lifecycle Step it does not remove the worktree and releases any Worker Slot; from Needs Human it must re-acquire a Worker Slot, run local cleanup, and only Abandons if cleanup succeeds—if no slot is free, the Work Item becomes Waiting for Worker Slot until admitted for that cleanup. It may be operator-directed (including from Needs Human) or applied automatically when a Refresh Job finds that a Needs Human Work Item whose latest step was Decide PR Merge, Merge PR, or Resolve PR Merge Conflict has a Work Item PR closed unmerged. Repository removal may apply it to non-running Work Items before deleting that Repository's lifecycle history. An Abandoned Work Item no longer prevents a later Implement Now request for the same Issue. Pause does not block Abandon. Abandon of a Work Item that is only Waiting for Worker Slot (never admitted, or waiting after Start) is immediate with no cleanup and no slot involved.
_Avoid_: Delete, cancel

**Reset**:
An operator-directed erasure of a Work Item that stops queued or running Step Runs, removes the Git worktree and branch, and deletes the Work Item and its Step Run history so the Issue returns to Not Implemented when it remains Relevant. Unlike Abandon, Reset does not preserve history. Reset is allowed while paused, Waiting for GitHub, Waiting for Worker Slot, or Waiting for blockers and removes the Work Item entirely, releasing a Worker Slot if one was held (including when a Step Run is still finishing after Pause). Waiting for blockers has no worktree yet; Reset is the operator cancel for a queued intent. Reset does not close, update, or otherwise mutate a competing Issue-closing PR.
_Avoid_: Abandon, Retry, cancel, Interrupt Work Item

**Failed Work Item**:
A terminal Work Item that cannot advance because a lifecycle precondition was not met—for example the referenced Issue is closed, missing, or no longer Relevant when the Work Item does not yet own a Work Item PR. Closing or removing the Issue while a Work Item PR is already owned does not produce a Failed Work Item; that path pauses or advances cleanup by PR lifecycle instead. Its Step Run retains the outcome of the Effect itself, and the Work Item records the separate failure reason. Unresolved status checks stop on a retryable failed Step Run rather than producing a Failed Work Item.
_Avoid_: Failed Step Run, Abandoned, Pause Work Item for closed Issue with owned PR

**Needs Human Work Item**:
A Work Item that cannot continue autonomously: either a Status Check Handoff cannot be processed autonomously or requires a human decision, Classify or `off` reaches the Check-Start Deadline without a successful status-check aggregate, Resolve PR Merge Conflict cannot rebase autonomously, Decide PR Merge requires a human (including when the effective Merge Policy is `off`), Merge PR cannot proceed after its revalidation budget is exhausted or the Forge rejects an unchanged mergeable PR or revalidation finds no successful checks except Always after the Check-Start Deadline with `no_checks`, Review exhausts its Review Fix Round limit without a clean or deferred outcome, Review cannot classify an unchanged apply-findings turn after one verdict-repair turn, or a Refresh Job observes an active Issue-closing PR that is not owned by this Work Item. It records a concise intervention reason. Entering Needs Human releases its Worker Slot. It is terminal for ordinary Lifecycle Step advancement, Pause, and Start, and it blocks a second Implement Now or Implement Locally for the same Issue. A Needs Human outcome from Investigate PR Status Checks, from a missing successful status-check aggregate on an autonomous merge path, from exhausting Review Fix Rounds, or from an unparseable unchanged apply-findings verdict may be retried after intervention; other Needs Human outcomes are not eligible for Retry, including a competing Issue-closing PR stop. The operator inspects the remote PR and Resets this Work Item to discard the local attempt. Already Needs Human Work Items keep their original intervention reason. A Refresh Job may still leave Needs Human when a Work Item PR is present: a merged Work Item PR advances to local cleanup toward Complete (superseding the handoff). When the latest step was Decide PR Merge, Merge PR, or Resolve PR Merge Conflict and the PR was closed unmerged, Refresh Abandons after local cleanup succeeds. When the latest step was Decide PR Merge or Merge PR and the open PR is conflicting, Refresh advances to Resolve PR Merge Conflict. When the latest step was Resolve PR Merge Conflict and the open PR is no longer conflicting, Refresh advances to Watch PR Status Checks so merge decision can run again; a still-conflicting Resolve handoff stays parked. Those Refresh-driven resumptions must re-acquire a Worker Slot; if none is free, the Work Item becomes Waiting for Worker Slot until admitted. Other Needs Human causes are not auto-resumed by Refresh when the PR is still open.
_Avoid_: Failed Work Item, Failed Step Run

**Complete Work Item**:
A terminal Work Item whose remote outcome is finished and whose local cleanup has finished. For changed work, the Work Item PR is merged, either by the harness after a clanker Decide PR Merge decision or an Always skip of Decide PR Merge, or by a human (or other external merge). Confirmed merge advances cleanup when known at Step Run Issue revalidation, or later via a Refresh Job—including when that merge supersedes an unfinished operational Lifecycle Step such as Watch or Investigate PR Status Checks, or a Work Item paused because the Issue closed while the Work Item PR was still open. Closing the linked Issue as part of the merge does not turn the Work Item into a Failed Work Item. Owning a Work Item PR number alone never Completes. For a No-Change Outcome, the Issue is closed without a pull request.
_Avoid_: Approved, done Issue

**Relevant Issue**:
A Ready-labeled Issue in a Supported Issue Hierarchy that remains pertinent to the harness. It must be either an open root Issue, or a direct child whose parent is open and Ready-labeled. It must also have no open Issue-closing PR, or have at least one open Issue-closing PR whose exact identity matches a Work Item PR recorded for that Issue, or a pending self-ownership observation on an unfinished Create PR Work Item's deterministic branch with matching source repository or project identity. While the Issue is closed, a merged Issue-closing PR is treated the same way as an open one; after the Issue is reopened that merged PR is historical and does not by itself make the Issue irrelevant. Closed unmerged (abandoned) Issue-closing PRs are ignored for this test. An Issue-closing PR affects only its own Issue rather than the Issue's parent or children. A competing active Issue-closing PR does not by itself remove an Issue that still has an exact owned or pending-self Issue-closing PR; that competitor still stops the unfinished Work Item. Unless Include all Issue Authors is on for the Repository, the Issue’s own Issue Author must match the Operator Forge User (case-insensitive); missing or ghost authors never match, and parent authorship does not include or exclude children. A closed root Issue, a child with a closed or non-Ready-labeled parent, an Issue with only unowned open Issue-closing PRs, or a still-closed Issue with only unowned merged Issue-closing PRs is not relevant.
_Avoid_: Active Issue (a Relevant Issue may be closed), Actionable Issue (actionability also depends on workflow constraints), Visible Issue (presentation-specific)
